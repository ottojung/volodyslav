/**
 * Persistence and restart tests for DependencyGraph.
 * These tests verify that the persistent reverse-dependency index works correctly across restarts.
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
            const db = await getDatabase(capabilities);

            // Set up initial data
            await db.put("all_events", {
                type: "all_events",
                events: [
                    { id: "id123", description: "Event 123" },
                    { id: "id456", description: "Event 456" },
                ],
            });

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

            // Pull the pattern instantiation to create it
            const result1 = await graphA.pull('event_context("id123")');
            expect(result1.eventId).toBe("id123");
            expect(result1.totalEvents).toBe(2);

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

            // Pull event_context again - should recompute with new data
            const result2 = await graphB.pull('event_context("id123")');
            expect(result2.eventId).toBe("id123");
            expect(result2.totalEvents).toBe(3); // Updated count

            await db.close();
        });

        test("diamond graph invalidation across restart", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);

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

            // Initial setup
            await db.put("A", { value: 10 });
            const graph1 = makeDependencyGraph(db, schemas);

            // Pull D to create instantiations
            const result1 = await graph1.pull('D("test")');
            expect(result1.value).toBe(50); // 10*2 + 10*3 = 20 + 30 = 50
            expect(computeCalls).toEqual(["B", "C", "D"]);

            // *** RESTART ***
            computeCalls.length = 0; // Reset
            const graph2 = makeDependencyGraph(db, schemas);

            // Update A
            await graph2.set("A", { value: 20 });

            // Pull D - should recompute with new value
            const result2 = await graph2.pull('D("test")');
            expect(result2.value).toBe(100); // 20*2 + 20*3 = 40 + 60 = 100
            expect(computeCalls).toEqual(["B", "C", "D"]);

            await db.close();
        });
    });

    describe("Restart preserves downstream up-to-date propagation", () => {
        test("Unchanged propagation works after restart", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);
            const { versionKey, depVersionsKey, makeDependencyVersions } = require("../src/generators/database");

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
                        // Always return Unchanged to test version stability
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

            // Initial setup
            await db.put("A", { value: 10 });
            await db.put(versionKey("A"), 1);
            await db.put(depVersionsKey("A"), makeDependencyVersions({}));
            
            await db.put("B", { value: 100 });
            await db.put(versionKey("B"), 1);
            await db.put(depVersionsKey("B"), makeDependencyVersions({ "A": 1 }));
            
            const graph1 = makeDependencyGraph(db, schemas);

            // Pull C to establish values
            const result1 = await graph1.pull("C");
            expect(result1.value).toBe(200);
            expect(computeCalls).toEqual(["C"]); // B is already up-to-date

            // *** RESTART ***
            computeCalls.length = 0;
            const graph2 = makeDependencyGraph(db, schemas);

            // Update A
            await graph2.set("A", { value: 20 });

            // Pull C - B will recompute and return Unchanged (version stays 1)
            // C sees B's version is still 1, so doesn't recompute
            const result2 = await graph2.pull("C");
            expect(result2.value).toBe(200); // Same as before
            expect(computeCalls).toEqual(["B"]); // Only B computed, C used cached value

            await db.close();
        });

        test("Unchanged propagation with pattern instantiation after restart", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);
            const { versionKey, depVersionsKey, makeDependencyVersions } = require("../src/generators/database");

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

            // Initial setup
            await db.put("A", { value: 10 });
            await db.put(versionKey("A"), 1);
            await db.put(depVersionsKey("A"), makeDependencyVersions({}));
            
            await db.put('B("test")', { value: 100 });
            await db.put(versionKey('B("test")'), 1);
            await db.put(depVersionsKey('B("test")'), makeDependencyVersions({ "A": 1 }));
            
            const graph1 = makeDependencyGraph(db, schemas);

            // Pull C to establish pattern instantiations
            const result1 = await graph1.pull('C("test")');
            expect(result1.value).toBe(200);

            // *** RESTART ***
            computeCalls.length = 0;
            const graph2 = makeDependencyGraph(db, schemas);

            // Update A
            await graph2.set("A", { value: 20 });

            // Pull C - B will recompute and return Unchanged (version stays 1)
            // C sees B's version is still 1, so doesn't recompute
            const result2 = await graph2.pull('C("test")');
            expect(result2.value).toBe(200); // Same value
            expect(computeCalls).toEqual(['B(test)']); // Only B computed

            await db.close();
        });
    });

    describe("No initialization scan required", () => {
        test("does not scan for instantiation markers", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);

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

            await db.put("base", { value: 10 });

            // Create graph - should NOT scan for "instantiation:" prefix
            const graph = makeDependencyGraph(db, schemas);

            // Pull to create instantiation
            await graph.pull('derived("test")');

            // Verify no "instantiation:" scan occurred during construction or pull
            const instantiationScans = keysCalls.filter((prefix) =>
                prefix.startsWith("instantiation:")
            );
            expect(instantiationScans.length).toBe(0);

            // Now do a set to trigger version update
            await graph.set("base", { value: 20 });

            // With versioning, set() no longer needs to query reverse dependencies
            // It just increments the node's version, which is a simple operation
            // Dependents will notice the version change when they're pulled

            await db.close();
        });
    });

    describe("Schema hash namespacing", () => {
        test("different schemas use different namespaces", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);

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

            await db.put("A", { value: 10 });

            // Create graph with schema1
            const graph1 = makeDependencyGraph(db, schemas1);
            const hash1 = graph1.schemaHash;

            // Create graph with schema2 (different schema)
            const graph2 = makeDependencyGraph(db, schemas2);
            const hash2 = graph2.schemaHash;

            // Different schemas should have different hashes
            expect(hash1).not.toBe(hash2);

            // Pull B with schema2
            await graph2.pull("B");

            // Verify schema2's index exists
            const revdepKey2 = `dg:${hash2}:revdep:A:B`;
            const revdep2 = await db.get(revdepKey2);
            expect(revdep2).toBeDefined();

            // Verify schema1's namespace is separate (no B index)
            const revdepKey1 = `dg:${hash1}:revdep:A:B`;
            const revdep1 = await db.get(revdepKey1);
            expect(revdep1).toBeUndefined();

            await db.close();
        });
    });

    describe("Index atomicity", () => {
        test("index entries are written in same batch as value", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);

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

            await db.put("A", { value: 10 });
            const graph = makeDependencyGraph(db, schemas);

            // Pull B to create instantiation
            await graph.pull('B("test")');

            // Find the batch that included both value and index writes
            let foundBatchWithBoth = false;
            for (const ops of batchCalls) {
                const hasValue = ops.some((op) => op.key === 'B("test")');
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
