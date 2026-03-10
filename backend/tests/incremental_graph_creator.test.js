/**
 * Tests for the IncrementalGraph getCreator() API.
 * Covers getCreator() method which records the hostname of the machine that
 * first computed each node.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { getRootDatabase } = require("../src/generators/incremental_graph/database");
const {
    makeIncrementalGraph,
    isMissingTimestamp,
    isInvalidNode,
} = require("../src/generators/incremental_graph");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger, stubEnvironment } = require("./stubs");

/**
 * Creates test capabilities with a temporary data directory.
 * @param {string} [hostname] - optional override hostname to stub
 */
function getTestCapabilities(hostname = "test-host") {
    const capabilities = getMockedRootCapabilities();
    const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "incremental-graph-creator-test-")
    );

    stubLogger(capabilities);
    stubEnvironment(capabilities);
    capabilities.environment.hostname = jest.fn().mockReturnValue(hostname);
    return { ...capabilities, tmpDir };
}

describe("generators/incremental_graph getCreator()", () => {
    test("returns the hostname string after node is first computed", async () => {
        const capabilities = getTestCapabilities("my-machine.example.com");
        const db = await getRootDatabase(capabilities);

        const graphDef = [
            {
                output: "src",
                inputs: [],
                computor: async () => ({ type: "meta_events", meta_events: [] }),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ];

        const graph = makeIncrementalGraph(capabilities, db, graphDef);
        await graph.invalidate("src");
        await graph.pull("src");

        const createdBy = await graph.getCreator("src");
        expect(createdBy).toBe("my-machine.example.com");

        await db.close();
    });

    test("stores the hostname from the environment at creation time", async () => {
        const capabilities = getTestCapabilities("host-a");
        const db = await getRootDatabase(capabilities);

        const graphDef = [
            {
                output: "node1",
                inputs: [],
                computor: async () => ({ type: "meta_events", meta_events: [] }),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ];

        const graph = makeIncrementalGraph(capabilities, db, graphDef);
        await graph.invalidate("node1");
        await graph.pull("node1");

        const createdBy = await graph.getCreator("node1");
        expect(createdBy).toBe("host-a");

        await db.close();
    });

    test("creator does not change after re-computation", async () => {
        const capabilities = getTestCapabilities("original-host");
        const db = await getRootDatabase(capabilities);

        let callCount = 0;
        const graphDef = [
            {
                output: "src",
                inputs: [],
                computor: async () => {
                    callCount++;
                    return { type: "meta_events", meta_events: [{ count: callCount }] };
                },
                isDeterministic: false,
                hasSideEffects: false,
            },
        ];

        const graph = makeIncrementalGraph(capabilities, db, graphDef);

        // First computation with original-host
        await graph.invalidate("src");
        await graph.pull("src");
        const firstCreator = await graph.getCreator("src");
        expect(firstCreator).toBe("original-host");

        // Simulate host change (shouldn't affect already-created node)
        capabilities.environment.hostname = jest.fn().mockReturnValue("new-host");

        // Second computation
        await graph.invalidate("src");
        await graph.pull("src");
        const secondCreator = await graph.getCreator("src");

        // Creator must not change after re-computation
        expect(secondCreator).toBe("original-host");

        await db.close();
    });

    test("throws MissingTimestampError when node has never been computed", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);

        const graphDef = [
            {
                output: "src",
                inputs: [],
                computor: async () => ({ type: "meta_events", meta_events: [] }),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ];

        const graph = makeIncrementalGraph(capabilities, db, graphDef);

        let error = null;
        try {
            await graph.getCreator("src");
        } catch (err) {
            error = err;
        }
        expect(error).not.toBeNull();
        expect(isMissingTimestamp(error)).toBe(true);

        await db.close();
    });

    test("throws InvalidNodeError when node is not in schema", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);

        const graph = makeIncrementalGraph(capabilities, db, []);

        let error = null;
        try {
            await graph.getCreator("nonexistent");
        } catch (err) {
            error = err;
        }
        expect(error).not.toBeNull();
        expect(isInvalidNode(error)).toBe(true);

        await db.close();
    });

    test("works with parameterized nodes (bindings)", async () => {
        const capabilities = getTestCapabilities("host-x");
        const db = await getRootDatabase(capabilities);

        const graphDef = [
            {
                output: "item(x)",
                inputs: [],
                computor: async (_inputs, _old, bindings) => ({
                    type: "meta_events",
                    meta_events: [{ id: bindings[0] }],
                }),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ];

        const graph = makeIncrementalGraph(capabilities, db, graphDef);

        await graph.invalidate("item", ["a"]);
        await graph.pull("item", ["a"]);

        await graph.invalidate("item", ["b"]);
        await graph.pull("item", ["b"]);

        const creatorA = await graph.getCreator("item", ["a"]);
        const creatorB = await graph.getCreator("item", ["b"]);

        expect(creatorA).toBe("host-x");
        expect(creatorB).toBe("host-x");

        await db.close();
    });

    test("throws MissingTimestampError for bindings that were never computed", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);

        const graphDef = [
            {
                output: "item(x)",
                inputs: [],
                computor: async () => ({ type: "meta_events", meta_events: [] }),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ];

        const graph = makeIncrementalGraph(capabilities, db, graphDef);

        await graph.invalidate("item", ["existing"]);
        await graph.pull("item", ["existing"]);

        let error = null;
        try {
            await graph.getCreator("item", ["missing"]);
        } catch (err) {
            error = err;
        }
        expect(error).not.toBeNull();
        expect(isMissingTimestamp(error)).toBe(true);

        await db.close();
    });
});
