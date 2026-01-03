/**
 * Persistence and restart tests for DependencyGraph.
 * These tests verify that the persistent reverse-dependency index works correctly across restarts.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { getRootDatabase } = require("../src/generators/database");
const {
    makeDependencyGraph,
    makeUnchanged,
} = require("../src/generators/dependency_graph");
const { getMockedRootCapabilities } = require("./spies");
const { makeTestDatabase } = require("./test_database_helper");
const { stubLogger } = require("./stubs");

/**
 * Creates test capabilities with a temporary data directory.
 */
function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "graph-persistence-test-")
    );

    stubLogger(capabilities);

    capabilities.environment = {
        pathToVolodyslavDataDirectory: jest.fn().mockReturnValue(tmpDir),
    };

    return { ...capabilities, tmpDir };
}

describe("Dependency graph persistence and restart", () => {
    describe("Restart preserves dependent invalidation", () => {
        test("invalidates pattern instantiation after restart", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            // Define graph with pattern node
            const schemas = [
                {
                    output: "all_events",
                    inputs: [],
                    computor: (inputs, oldValue, _bindings) => oldValue,
                },
                {
                    output: "meta_events",
                    inputs: ["all_events"],
                    computor: (inputs, _oldValue, _bindings) => {
                        return {
                            type: "meta_events",
                            count: inputs[0].events.length,
                        };
                    },
                },
                {
                    output: "event_context(e)",
                    inputs: ["meta_events"],
                    computor: (inputs, _oldValue, bindings) => {
                        const metaEvents = inputs[0];
                        return {
                            type: "event_context",
                            eventId: bindings.e.value,
                            totalEvents: metaEvents.count,
                        };
                    },
                },
            ];

            // Create graph instance A
            const graphA = makeDependencyGraph(db, schemas);

            const testDb = makeTestDatabase(graphA);

            // Set up initial data
            await testDb.put("all_events", {
                type: "all_events",
                events: [
                    { id: "id123", description: "Event 123" },
                    { id: "id456", description: "Event 456" },
                ],
            });

            // Pull the pattern instantiation to create it
            const result1 = await graphA.pull("event_context('id123')");
            expect(result1.eventId).toBe("id123");
            expect(result1.totalEvents).toBe(2);

            // Verify all nodes are up-to-date
            const freshness1 = await graphA.debugGetFreshness("all_events");
            const freshness2 = await graphA.debugGetFreshness("meta_events");
            const freshness3 = await graphA.debugGetFreshness("event_context('id123')");
            expect(freshness1).toBe("up-to-date");
            expect(freshness2).toBe("up-to-date");
            expect(freshness3).toBe("up-to-date");

            // *** RESTART: Create new graph instance B on same DB ***
            const graphB = makeDependencyGraph(db, schemas);

            // Update all_events
            await graphB.set("all_events", {
                type: "all_events",
                events: [
                    { id: "id123", description: "Event 123" },
                    { id: "id456", description: "Event 456" },
                    { id: "id789", description: "Event 789" },
                ],
            });

            // Verify that meta_events and event_context became potentially-outdated
            const freshnessAfter1 = await graphB.debugGetFreshness("meta_events");
            const freshnessAfter2 = await graphB.debugGetFreshness("event_context('id123')");
            expect(freshnessAfter1).toBe("potentially-outdated");
            expect(freshnessAfter2).toBe("potentially-outdated");

            // Pull event_context and verify it recomputes correctly
            const result2 = await graphB.pull("event_context('id123')");
            expect(result2.eventId).toBe("id123");
            expect(result2.totalEvents).toBe(3); // Updated!

            await db.close();
        });

        test("diamond graph invalidation across restart", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);
            const computeCalls = [];

            const schemas = [
                {
                    output: "A",
                    inputs: [],
                    computor: (_inputs, oldValue, _bindings) => oldValue,
                },
                {
                    output: "B(x)",
                    inputs: ["A"],
                    computor: (inputs, _oldValue, bindings) => {
                        computeCalls.push("B");
                        return {
                            id: bindings.x.value,
                            value: inputs[0].value * 2,
                        };
                    },
                },
                {
                    output: "C(x)",
                    inputs: ["A"],
                    computor: (inputs, _oldValue, bindings) => {
                        computeCalls.push("C");
                        return {
                            id: bindings.x.value,
                            value: inputs[0].value * 3,
                        };
                    },
                },
                {
                    output: "D(x)",
                    inputs: ['B(x)', 'C(x)'],
                    computor: (inputs, _oldValue, bindings) => {
                        computeCalls.push("D");
                        return {
                            id: bindings.x.value,
                            value: inputs[0].value + inputs[1].value,
                        };
                    },
                },
            ];

            const graph1 = makeDependencyGraph(db, schemas);

            const testDb = makeTestDatabase(graph1);

            // Initial setup
            await testDb.put("A", { value: 10 });

            // Pull D to create instantiations
            const result1 = await graph1.pull("D('test')");
            expect(result1.value).toBe(50); // 10*2 + 10*3 = 20 + 30 = 50
            expect(computeCalls).toEqual(["B", "C", "D"]);

            // *** RESTART ***
            computeCalls.length = 0; // Reset
            const graph2 = makeDependencyGraph(db, schemas);

            // Update A
            await graph2.set("A", { value: 20 });

            // Verify D became potentially-outdated via persisted edges
            const freshness = await graph2.debugGetFreshness("D('test')");
            expect(freshness).toBe("potentially-outdated");

            // Pull D - should recompute
            const result2 = await graph2.pull("D('test')");
            expect(result2.value).toBe(100); // 20*2 + 20*3 = 40 + 60 = 100
            expect(computeCalls).toEqual(["B", "C", "D"]);

            await db.close();
        });
    });

    describe("Restart preserves downstream up-to-date propagation", () => {
        test("Unchanged propagation works after restart", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);
            const computeCalls = [];

            const schemas = [
                {
                    output: "A",
                    inputs: [],
                    computor: (_inputs, oldValue, _bindings) => oldValue,
                },
                {
                    output: "B",
                    inputs: ["A"],
                    computor: (_inputs, _oldValue, _bindings) => {
                        computeCalls.push("B");
                        // Always return Unchanged to test propagation
                        return makeUnchanged();
                    },
                },
                {
                    output: "C",
                    inputs: ["B"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("C");
                        return { value: inputs[0].value * 2 };
                    },
                },
            ];

            const graph1 = makeDependencyGraph(db, schemas);

            const testDb = makeTestDatabase(graph1);

            // Initial setup
            await testDb.put("A", { value: 10 });
            await testDb.put("B", { value: 100 });

            // Pull C to establish values
            const result1 = await graph1.pull("C");
            expect(result1.value).toBe(200);
            expect(computeCalls).toEqual(["B", "C"]);

            // All should be up-to-date
            expect(await graph1.debugGetFreshness("A")).toBe("up-to-date");
            expect(await graph1.debugGetFreshness("B")).toBe("up-to-date");
            expect(await graph1.debugGetFreshness("C")).toBe("up-to-date");

            // *** RESTART ***
            computeCalls.length = 0;
            const graph2 = makeDependencyGraph(db, schemas);

            // Update A (which should invalidate B and C)
            await graph2.set("A", { value: 20 });

            // B and C should be potentially-outdated
            expect(await graph2.debugGetFreshness("B")).toBe("potentially-outdated");
            expect(await graph2.debugGetFreshness("C")).toBe("potentially-outdated");

            // Pull C - B should return Unchanged and propagate up-to-date to C
            const result2 = await graph2.pull("C");
            expect(result2.value).toBe(200); // Same as before
            expect(computeCalls).toEqual(["B"]); // Only B computed, C was marked up-to-date via propagation

            // Both B and C should be up-to-date now
            expect(await graph2.debugGetFreshness("B")).toBe("up-to-date");
            expect(await graph2.debugGetFreshness("C")).toBe("up-to-date");

            await db.close();
        });

        test("Unchanged propagation with pattern instantiation after restart", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);
            const computeCalls = [];

            const schemas = [
                {
                    output: "A",
                    inputs: [],
                    computor: (_inputs, oldValue, _bindings) => oldValue,
                },
                {
                    output: "B(x)",
                    inputs: ["A"],
                    computor: (inputs, _oldValue, bindings) => {
                        computeCalls.push(`B(${bindings.x.value})`);
                        return makeUnchanged();
                    },
                },
                {
                    output: "C(x)",
                    inputs: ['B(x)'],
                    computor: (inputs, _oldValue, bindings) => {
                        computeCalls.push(`C(${bindings.x.value})`);
                        return {
                            id: bindings.x.value,
                            value: inputs[0].value * 2,
                        };
                    },
                },
            ];

            const graph1 = makeDependencyGraph(db, schemas);

            const testDb = makeTestDatabase(graph1);

            // Initial setup
            await testDb.put("A", { value: 10 });
            await testDb.put("B('test')", { value: 100 });

            // Pull C to establish pattern instantiations
            const result1 = await graph1.pull("C('test')");
            expect(result1.value).toBe(200);

            // *** RESTART ***
            computeCalls.length = 0;
            const graph2 = makeDependencyGraph(db, schemas);

            // Update A
            await graph2.set("A", { value: 20 });

            // Pull C - B should return Unchanged and propagate to C
            const result2 = await graph2.pull("C('test')");
            expect(result2.value).toBe(200); // Same value
            expect(computeCalls).toEqual(['B(test)']); // Only B computed

            // C should be up-to-date via propagation
            expect(await graph2.debugGetFreshness("C('test')")).toBe("up-to-date");

            await db.close();
        });
    });

    describe("No initialization scan required", () => {
        test.skip("does not scan for instantiation markers", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            // Track DB keys() calls
            const originalKeys = db.keys.bind(db);
            const keysCalls = [];
            db.keys = jest.fn(async (prefix) => {
                keysCalls.push(prefix);
                return originalKeys(prefix);
            });

            const schemas = [
                {
                    output: "base",
                    inputs: [],
                    computor: (_inputs, oldValue, _bindings) => oldValue,
                },
                {
                    output: "derived(x)",
                    inputs: ["base"],
                    computor: (inputs, _oldValue, bindings) => ({
                        id: bindings.x.value,
                        value: inputs[0].value * 2,
                    }),
                },
            ];

            await testDb.put("base", { value: 10 });

            // Create graph - should NOT scan for "instantiation:" prefix
            const graph = makeDependencyGraph(db, schemas);

            const testDb = makeTestDatabase(graph);
            // Pull to create instantiation
            await graph.pull("derived('test')");

            // Verify no "instantiation:" scan occurred during construction or pull
            const instantiationScans = keysCalls.filter((prefix) =>
                prefix.startsWith("instantiation:")
            );
            expect(instantiationScans.length).toBe(0);

            // Now do a set to trigger invalidation checks (which use revdep queries)
            await graph.set("base", { value: 20 });

            // Verify that revdep queries occurred during set (these are legitimate)
            const revdepScans = keysCalls.filter((prefix) =>
                prefix.includes(":revdep:")
            );
            expect(revdepScans.length).toBeGreaterThan(0);

            await db.close();
        });
    });

    describe("Schema hash namespacing", () => {
        test("different schemas use different namespaces", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const schemas1 = [
                {
                    output: "A",
                    inputs: [],
                    computor: (_inputs, oldValue, _bindings) => oldValue,
                },
            ];

            const schemas2 = [
                {
                    output: "A",
                    inputs: [],
                    computor: (_inputs, oldValue, _bindings) => oldValue,
                },
                {
                    output: "B",
                    inputs: ["A"],
                    computor: (inputs, _oldValue, _bindings) => ({
                        value: inputs[0].value * 2,
                    }),
                },
            ];

            // Create graph with schema1
            const graph1 = makeDependencyGraph(db, schemas1);
            const hash1 = graph1.schemaHash;

            const testDb = makeTestDatabase(graph1);

            await testDb.put("A", { value: 10 });

            // Create graph with schema2 (different schema)
            const graph2 = makeDependencyGraph(db, schemas2);
            const hash2 = graph2.schemaHash;

            // Different schemas should have different hashes
            expect(hash1).not.toBe(hash2);

            // Pull B with schema2
            await graph2.pull("B");

            // Verify that schema2 can list dependents properly
            const storage2 = graph2.getStorage();
            const dependents2 = await storage2.listDependents("A");
            expect(dependents2).toContain("B");

            // Verify schema1's namespace is separate (no B in schema1)
            const storage1 = graph1.getStorage();
            const dependents1 = await storage1.listDependents("A");
            expect(dependents1).not.toContain("B"); // schema1 doesn't have B node

            await db.close();
        });
    });

    describe("Index atomicity", () => {
        test("index entries are written in same batch as value", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const schemas = [
                {
                    output: "A",
                    inputs: [],
                    computor: (_inputs, oldValue, _bindings) => oldValue,
                },
                {
                    output: "B(x)",
                    inputs: ["A"],
                    computor: (inputs, _oldValue, bindings) => ({
                        id: bindings.x.value,
                        value: inputs[0].value * 2,
                    }),
                },
            ];

            // Track batch operations
            const originalBatch = db.batch.bind(db);
            const batchCalls = [];
            db.batch = jest.fn(async (ops) => {
                batchCalls.push(ops);
                return originalBatch(ops);
            });

            await testDb.put("A", { value: 10 });
            const graph = makeDependencyGraph(db, schemas);

            const testDb = makeTestDatabase(graph);
            // Pull B to create instantiation
            await graph.pull("B('test')");

            // Find the batch that included both value and index writes
            let foundBatchWithBoth = false;
            for (const ops of batchCalls) {
                const hasValue = ops.some((op) => op.key === "B('test')");
                const hasIndex = ops.some((op) =>
                    op.key.includes(":inputs:") || op.key.includes(":revdep:")
                );

                if (hasValue && hasIndex) {
                    foundBatchWithBoth = true;
                    break;
                }
            }

            // Verify that index and value were written in same batch
            expect(foundBatchWithBoth).toBe(true);

            await db.close();
        });
    });
});
