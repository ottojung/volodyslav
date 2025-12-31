/**
 * Test for the freshness issue described in the GitHub issue.
 * 
 * This test demonstrates the unsound "Unchanged propagation" algorithm.
 * 
 * Scenario:
 * - D depends on A and N
 * - A's value changes (so D truly needs recomputation)
 * - N recomputes and returns Unchanged
 * - The unsound algorithm would mark D up-to-date without recomputing
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { get: getDatabase } = require("../src/generators/database");
const {
    makeDependencyGraph,
    makeUnchanged,
} = require("../src/generators/dependency_graph");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger } = require("./stubs");

/**
 * @typedef {import('../src/generators/database/types').DatabaseCapabilities} DatabaseCapabilities
 */

/**
 * Creates test capabilities with a temporary data directory.
 * @returns {DatabaseCapabilities & { tmpDir: string }}
 */
function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "freshness-issue-test-")
    );

    stubLogger(capabilities);

    // Override environment to use temp directory
    capabilities.environment = {
        pathToVolodyslavDataDirectory: jest.fn().mockReturnValue(tmpDir),
    };

    return { ...capabilities, tmpDir };
}

describe("Freshness Issue - Unsound Unchanged Propagation", () => {
    test("diamond where A changes, N returns Unchanged - D must recompute", async () => {
        const capabilities = getTestCapabilities();
        const db = await getDatabase(capabilities);
        const { freshnessKey } = require("../src/generators/database");

        const computeCalls = [];

        // Diamond structure:
        //     A (source)
        //    / \
        //   N   (direct edge to D)
        //    \ /
        //     D
        // 
        // Where:
        // - A is a source node that changes value
        // - N depends on A and returns Unchanged
        // - D depends on both A and N
        // - D should recompute because A changed, even though N returned Unchanged

        // Initial state: A = 1, N = 10, D = 11
        await db.put("A", { value: 1 });
        await db.put(freshnessKey("A"), "up-to-date");

        await db.put("N", { value: 10 });
        await db.put(freshnessKey("N"), "up-to-date");

        await db.put("D", { value: 11 });
        await db.put(freshnessKey("D"), "up-to-date");

        const graphDef = [
            {
                output: "A",
                inputs: [],
                computor: (inputs, oldValue, _bindings) => {
                    computeCalls.push("A");
                    return oldValue || { value: 1 };
                },
            },
            {
                output: "N",
                inputs: ["A"],
                computor: (_inputs, _oldValue, _bindings) => {
                    computeCalls.push("N");
                    // N always returns Unchanged, ignoring A's value
                    return makeUnchanged();
                },
            },
            {
                output: "D",
                inputs: ["A", "N"],
                computor: (inputs, _oldValue, _bindings) => {
                    computeCalls.push("D");
                    // D computes: A.value + N.value
                    return { value: inputs[0].value + inputs[1].value };
                },
            },
        ];

        const graph = makeDependencyGraph(db, graphDef);

        // Change A from 1 to 5
        await graph.set("A", { value: 5 });

        // Now pull D
        // Expected behavior:
        // 1. D is potentially-outdated (because A changed)
        // 2. Pull A -> returns 5 (up-to-date)
        // 3. Pull N -> recomputes, returns Unchanged (stays 10)
        // 4. D MUST recompute because A's value changed from 1 to 5
        //    Even though N returned Unchanged, D depends directly on A
        //    and A's value has changed since D was last computed
        // 5. D should compute to 5 + 10 = 15

        const result = await graph.pull("D");

        // D should have recomputed with new A value
        expect(result.value).toBe(15); // 5 + 10

        // Verify that D was actually computed
        expect(computeCalls).toContain("D");

        // The unsound algorithm would:
        // 1. After N returns Unchanged, mark N up-to-date
        // 2. Propagate up-to-date to D (because both A and N are now up-to-date)
        // 3. Skip D's recomputation
        // 4. Return the OLD value of D (11)
        // This would be WRONG!

        await db.close();
    });

    test("complex diamond - multiple paths, one Unchanged", async () => {
        const capabilities = getTestCapabilities();
        const db = await getDatabase(capabilities);
        const { freshnessKey } = require("../src/generators/database");

        const computeCalls = [];

        // More complex diamond:
        //       A
        //      / \
        //     B   C
        //      \ /
        //       D
        // 
        // Where B returns Unchanged and C returns a new value
        // D should recompute because C changed

        await db.put("A", { value: 1 });
        await db.put(freshnessKey("A"), "up-to-date");

        await db.put("B", { value: 10 });
        await db.put(freshnessKey("B"), "up-to-date");

        await db.put("C", { value: 20 });
        await db.put(freshnessKey("C"), "up-to-date");

        await db.put("D", { value: 30 });
        await db.put(freshnessKey("D"), "up-to-date");

        const graphDef = [
            {
                output: "A",
                inputs: [],
                computor: (inputs, oldValue, _bindings) => {
                    computeCalls.push("A");
                    return oldValue || { value: 1 };
                },
            },
            {
                output: "B",
                inputs: ["A"],
                computor: (_inputs, _oldValue, _bindings) => {
                    computeCalls.push("B");
                    return makeUnchanged();
                },
            },
            {
                output: "C",
                inputs: ["A"],
                computor: (inputs, _oldValue, _bindings) => {
                    computeCalls.push("C");
                    // C computes A * 10
                    return { value: inputs[0].value * 10 };
                },
            },
            {
                output: "D",
                inputs: ["B", "C"],
                computor: (inputs, _oldValue, _bindings) => {
                    computeCalls.push("D");
                    // D computes B + C
                    return { value: inputs[0].value + inputs[1].value };
                },
            },
        ];

        const graph = makeDependencyGraph(db, graphDef);

        // Change A from 1 to 5
        await graph.set("A", { value: 5 });

        // Pull D
        const result = await graph.pull("D");

        // C computes to 50 (5 * 10)
        // B stays 10 (Unchanged)
        // D should compute to 60 (10 + 50)
        expect(result.value).toBe(60);

        // D must have been computed
        expect(computeCalls).toContain("D");

        await db.close();
    });
});
