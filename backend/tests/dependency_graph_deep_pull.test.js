/**
 * Tests for deep dependency graph pulls without stack overflow.
 * Tests the iterative pull implementation.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { getRootDatabase } = require("../src/generators/dependency_graph/database");
const { makeDependencyGraph } = require("../src/generators/dependency_graph");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger } = require("./stubs");

/**
 * @typedef {import('../src/generators/dependency_graph/database/types').DatabaseCapabilities} DatabaseCapabilities
 */

/**
 * Creates test capabilities with a temporary data directory.
 * @returns {DatabaseCapabilities & { tmpDir: string }}
 */
function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "dependency-graph-deep-test-")
    );

    stubLogger(capabilities);

    capabilities.environment = {
        pathToVolodyslavDataDirectory: jest.fn().mockReturnValue(tmpDir),
    };

    return { ...capabilities, tmpDir };
}

describe("Deep dependency graph pull", () => {
    test("handles deep chain without stack overflow", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);

        // Create a chain of 50000 nodes: n0 -> n1 -> n2 -> ... -> n49999
        // Each node depends on the previous one
        const chainLength = 50000;
        const nodeDefs = [];

        // First node is a source
        nodeDefs.push({
            output: "n0",
            inputs: [],
            computor: () => ({ value: 0 }),
            isDeterministic: true,
            hasSideEffects: false,
        });

        // Chain nodes
        for (let i = 1; i < chainLength; i++) {
            nodeDefs.push({
                output: `n${i}`,
                inputs: [`n${i - 1}`],
                computor: (_inputs) => {
                    const prevValue = _inputs[0];
                    return { value: prevValue.value + 1 };
                },
                isDeterministic: true,
                hasSideEffects: false,
            });
        }

        const graph = makeDependencyGraph(db, nodeDefs);

        // Set the source node
        await graph.set("n0", { value: 0 });

        // Pull the final node - this should not cause stack overflow
        const result = await graph.pull(`n${chainLength - 1}`);

        expect(result).toEqual({ value: chainLength - 1 });

        await db.close();
        fs.rmSync(capabilities.tmpDir, { recursive: true, force: true });
    }, 120000); // 120 second timeout for 50k node chain

    test("per-node commit: partial success persists early nodes", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);

        // Create a chain where node 3 fails
        let node3CallCount = 0;

        const nodeDefs = [
            {
                output: "n0",
                inputs: [],
                computor: () => ({ value: 0 }),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "n1",
                inputs: ["n0"],
                computor: (inputs) => {
                    return { value: inputs[0].value + 1 };
                },
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "n2",
                inputs: ["n1"],
                computor: (inputs) => {
                    return { value: inputs[0].value + 1 };
                },
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "n3",
                inputs: ["n2"],
                computor: (_inputs) => {
                    node3CallCount++;
                    throw new Error("Node 3 computation failed");
                },
                isDeterministic: true,
                hasSideEffects: false,
            },
        ];

        const graph = makeDependencyGraph(db, nodeDefs);

        // Set the source
        await graph.set("n0", { value: 0 });

        // Try to pull n3, should fail
        await expect(graph.pull("n3")).rejects.toThrow("Node 3 computation failed");

        // Verify that n1 and n2 were successfully computed and persisted
        const n1Value = await graph.pull("n1");
        expect(n1Value).toEqual({ value: 1 });

        const n2Value = await graph.pull("n2");
        expect(n2Value).toEqual({ value: 2 });

        // Verify n3 was called only once (not multiple times on retry)
        expect(node3CallCount).toBe(1);

        await db.close();
        fs.rmSync(capabilities.tmpDir, { recursive: true, force: true });
    }, 30000); // 30 second timeout
});
