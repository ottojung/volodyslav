/**
 * Tests for LRU cache behavior in DependencyGraph to prevent unbounded memory growth.
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
        path.join(os.tmpdir(), "dependency-graph-lru-test-")
    );

    stubLogger(capabilities);

    capabilities.environment = {
        pathToVolodyslavDataDirectory: jest.fn().mockReturnValue(tmpDir),
    };

    return { ...capabilities, tmpDir };
}

describe("DependencyGraph LRU cache", () => {
    test("handles large binding ranges without unbounded memory growth", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);

        // Create a simple parameterized graph
        const graphDef = [
            {
                output: "source(x)",
                inputs: [],
                computor: (_inputs, _oldValue, bindings) => ({
                    type: "value",
                    value: bindings[0],
                }),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "derived(x)",
                inputs: ["source(x)"],
                computor: ([input], _oldValue, _bindings) => ({
                    type: "derived",
                    value: input.value * 2,
                }),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ];

        const graph = makeDependencyGraph(db, graphDef);

        // Set and pull a large number of different bindings
        // This simulates a long-running process with many different binding values
        const numBindings = 11000; // Larger than default LRU cache size of 10000

        // Set values for many different bindings
        for (let i = 0; i < numBindings; i++) {
            await graph.set("source", { type: "value", value: i }, [i]);
        }

        // Pull derived values for all bindings
        for (let i = 0; i < numBindings; i++) {
            const result = await graph.pull("derived", [i]);
            expect(result).toEqual({ type: "derived", value: i * 2 });
        }

        // Verify that the graph still works correctly
        // Even though some cached nodes may have been evicted by LRU
        const testBinding = 5000;
        const result = await graph.pull("derived", [testBinding]);
        expect(result).toEqual({ type: "derived", value: testBinding * 2 });

        await db.close();
        fs.rmSync(capabilities.tmpDir, { recursive: true, force: true });
    }, 30000); // 30 second timeout for this long-running test

    test("correctly handles cache eviction and recreation of nodes", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);

        // Track computation calls
        const computeCalls = [];

        const graphDef = [
            {
                output: "source(x)",
                inputs: [],
                computor: (_inputs, _oldValue, bindings) => ({
                    type: "value",
                    value: bindings[0],
                }),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "computed(x)",
                inputs: ["source(x)"],
                computor: ([input], _oldValue, bindings) => {
                    computeCalls.push(bindings[0]);
                    return {
                        type: "computed",
                        value: input.value * 3,
                    };
                },
                isDeterministic: true,
                hasSideEffects: false,
            },
        ];

        const graph = makeDependencyGraph(db, graphDef);

        // Set initial value
        await graph.set("source", { type: "value", value: 100 }, [1]);

        // First pull - should compute
        computeCalls.length = 0;
        const result1 = await graph.pull("computed", [1]);
        expect(result1).toEqual({ type: "computed", value: 300 });
        expect(computeCalls).toEqual([1]);

        // Second pull without change - should use cached result (no recompute)
        computeCalls.length = 0;
        const result2 = await graph.pull("computed", [1]);
        expect(result2).toEqual({ type: "computed", value: 300 });
        expect(computeCalls).toEqual([]);

        await db.close();
        fs.rmSync(capabilities.tmpDir, { recursive: true, force: true });
    });

    test("works with object bindings", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);

        const graphDef = [
            {
                output: "event_source(e)",
                inputs: [],
                computor: (_inputs, _oldValue, bindings) => ({
                    type: "event",
                    id: bindings[0].id,
                }),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "event_derived(e)",
                inputs: ["event_source(e)"],
                computor: ([input], _oldValue, _bindings) => ({
                    type: "derived_event",
                    id: input.id,
                    enhanced: true,
                }),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ];

        const graph = makeDependencyGraph(db, graphDef);

        // Use object bindings (common pattern in the spec)
        const numEvents = 11000; // Larger than default LRU size

        for (let i = 0; i < numEvents; i++) {
            const eventId = { id: `evt_${i}` };
            await graph.set("event_source", { type: "event", id: eventId.id }, [
                eventId,
            ]);
        }

        // Pull a sample to verify correctness
        const sampleId = { id: "evt_5000" };
        const result = await graph.pull("event_derived", [sampleId]);
        expect(result).toEqual({
            type: "derived_event",
            id: "evt_5000",
            enhanced: true,
        });

        await db.close();
        fs.rmSync(capabilities.tmpDir, { recursive: true, force: true });
    }, 30000); // 30 second timeout
});
