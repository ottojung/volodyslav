/**
 * Tests for dependency graph counter-based optimization.
 * These tests verify that nodes can skip recomputation when input counters haven't changed.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { getRootDatabase } = require("../src/generators/dependency_graph/database");
const {
    makeDependencyGraph,
    makeUnchanged,
} = require("../src/generators/dependency_graph");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger } = require("./stubs");
const { toJsonKey } = require("./test_json_key_helper");

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
        path.join(os.tmpdir(), "dependency-graph-counter-test-")
    );

    stubLogger(capabilities);

    // Override environment to use temp directory
    capabilities.environment = {
        pathToVolodyslavDataDirectory: jest.fn().mockReturnValue(tmpDir),
    };

    return { ...capabilities, tmpDir };
}

describe("generators/dependency_graph counters", () => {
    describe("Counter-based optimization", () => {
        test("skips recomputation when input returns Unchanged (counter doesn't change)", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            // Track computation counts
            let bComputes = 0;
            let aComputes = 0;

            const graphDef = [
                {
                    output: "src",
                    inputs: [],
                    computor: async () => ({
                        type: "all_events",
                        events: [],
                    }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "b",
                    inputs: ["src"],
                    computor: async (inputs, oldValue) => {
                        bComputes++;
                        // b returns Unchanged when src changes - this means b's counter should NOT increment
                        if (oldValue) {
                            return makeUnchanged();
                        }
                        return { type: "meta_events", meta_events: [] };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "a",
                    inputs: ["b"],
                    computor: async () => {
                        aComputes++;
                        return { type: "meta_events", meta_events: [] };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeDependencyGraph(db, graphDef);

            // Step 1: set src
            await graph.set("src", { type: "all_events", events: [1] });

            // Step 2: pull a - should compute both b and a
            await graph.pull("a");
            expect(bComputes).toBe(1);
            expect(aComputes).toBe(1);

            // Step 3: set src again (different value)
            await graph.set("src", { type: "all_events", events: [2] });

            // Step 4: pull b - should recompute b, but b returns Unchanged
            await graph.pull("b");
            expect(bComputes).toBe(2);

            // Step 5: pull a - should NOT recompute a because b's counter didn't change
            // This is the key test: a should skip recomputation
            await graph.pull("a");
            expect(aComputes).toBe(1); // Should still be 1, not 2

            await db.close();
        });

        test("recomputes when input counter actually changed", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            let bComputes = 0;
            let aComputes = 0;

            const graphDef = [
                {
                    output: "src",
                    inputs: [],
                    computor: async () => ({
                        type: "all_events",
                        events: [],
                    }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "b",
                    inputs: ["src"],
                    computor: async (inputs) => {
                        bComputes++;
                        // b returns a new value (counter increments)
                        return {
                            type: "meta_events",
                            meta_events: [{ value: inputs[0].events.length }],
                        };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "a",
                    inputs: ["b"],
                    computor: async () => {
                        aComputes++;
                        return { type: "meta_events", meta_events: [] };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeDependencyGraph(db, graphDef);

            await graph.set("src", { type: "all_events", events: [1] });
            await graph.pull("a");
            expect(bComputes).toBe(1);
            expect(aComputes).toBe(1);

            await graph.set("src", { type: "all_events", events: [2, 3] });
            await graph.pull("b");
            expect(bComputes).toBe(2);

            // b's counter changed, so a must recompute
            await graph.pull("a");
            expect(aComputes).toBe(2);

            await db.close();
        });

        test("multi-input counter snapshot comparison", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            let aComputes = 0;

            const graphDef = [
                {
                    output: "b",
                    inputs: [],
                    computor: async () => ({
                        type: "all_events",
                        events: [],
                    }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "c",
                    inputs: [],
                    computor: async () => ({
                        type: "all_events",
                        events: [],
                    }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "a",
                    inputs: ["b", "c"],
                    computor: async () => {
                        aComputes++;
                        return { type: "meta_events", meta_events: [] };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeDependencyGraph(db, graphDef);

            await graph.set("b", { type: "all_events", events: [1] });
            await graph.set("c", { type: "all_events", events: [2] });
            await graph.pull("a");
            expect(aComputes).toBe(1);

            // Change only b
            await graph.set("b", { type: "all_events", events: [3] });
            await graph.pull("a");
            expect(aComputes).toBe(2); // Should recompute

            // Don't change anything, just pull again
            await graph.pull("a");
            expect(aComputes).toBe(2); // Should NOT recompute (counters match snapshot)

            await db.close();
        });

        test("enforces invariants - missing counter throws error", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const graphDef = [
                {
                    output: "src",
                    inputs: [],
                    computor: async () => ({
                        type: "all_events",
                        events: [],
                    }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "derived",
                    inputs: ["src"],
                    computor: async () => ({
                        type: "meta_events",
                        meta_events: [],
                    }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeDependencyGraph(db, graphDef);

            // Set src to create a value
            await graph.set("src", { type: "all_events", events: [1] });
            await graph.pull("derived");

            // Manually corrupt the database by deleting the counter for src
            const storage = graph.getStorage();
            await storage.counters.del(toJsonKey("src", []));
            
            // Invalidate derived by marking it potentially-outdated
            await storage.freshness.put(toJsonKey("derived", []), "potentially-outdated");

            // Now trying to pull derived should throw because src's counter is missing
            await expect(graph.pull("derived")).rejects.toThrow();

            await db.close();
        });

        test("enforces invariants - missing inputCounters throws error", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const graphDef = [
                {
                    output: "src",
                    inputs: [],
                    computor: async () => ({
                        type: "all_events",
                        events: [],
                    }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "derived",
                    inputs: ["src"],
                    computor: async () => ({
                        type: "meta_events",
                        meta_events: [],
                    }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeDependencyGraph(db, graphDef);

            await graph.set("src", { type: "all_events", events: [1] });
            await graph.pull("derived");

            // Manually corrupt the database by removing inputCounters from derived's InputsRecord
            const storage = graph.getStorage();
            const derivedKey = toJsonKey("derived", []);
            const inputsRecord = await storage.inputs.get(derivedKey);
            if (inputsRecord) {
                // Remove inputCounters field
                delete inputsRecord.inputCounters;
                await storage.inputs.put(derivedKey, inputsRecord);
            }

            // Invalidate derived
            await graph.set("src", { type: "all_events", events: [2] });

            // Now trying to pull derived should throw because inputCounters is missing
            await expect(graph.pull("derived")).rejects.toThrow();

            await db.close();
        });

        test("recomputes when InputsRecord input list changes", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            // Schema with derived depending on sourceA
            const graphDef = [
                {
                    output: "sourceA",
                    inputs: [],
                    computor: async () => ({ type: "all_events", events: [1, 2, 3] }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "sourceB",
                    inputs: [],
                    computor: async () => ({ type: "all_events", events: [4, 5] }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "derived",
                    inputs: ["sourceA"],
                    computor: async (inputs) => ({
                        type: "meta_events",
                        meta_events: [{ source: "A", value: inputs[0].events.length }],
                    }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeDependencyGraph(db, graphDef);

            // Set up initial state
            await graph.set("sourceA", { type: "all_events", events: [1, 2, 3] });
            await graph.set("sourceB", { type: "all_events", events: [4, 5] });
            const resultV1 = await graph.pull("derived");
            
            // Derived should have meta_events with value 3 (from sourceA)
            expect(resultV1.meta_events[0].value).toBe(3);
            expect(resultV1.meta_events[0].source).toBe("A");

            // Now manually corrupt the InputsRecord to point to sourceB instead
            // This simulates a database corruption scenario
            const storage = graph.getStorage();
            const derivedKey = toJsonKey("derived", []);
            const sourceBKey = toJsonKey("sourceB", []);
            
            // Get sourceB's counter
            const sourceBCounter = await storage.counters.get(sourceBKey);
            
            // Corrupt the InputsRecord
            await storage.inputs.put(derivedKey, {
                inputs: [sourceBKey], // Changed to sourceB!
                inputCounters: [sourceBCounter]
            });
            
            // Mark derived as potentially-outdated
            await storage.freshness.put(derivedKey, "potentially-outdated");

            // When we pull derived, it should detect the mismatch, skip counter optimization,
            // and recompute using the correct inputs from the schema (sourceA)
            const resultV2 = await graph.pull("derived");
            
            // Result should be correct according to schema (sourceA with 3 events)
            // Not corrupted data (sourceB with 2 events)
            expect(resultV2.meta_events[0].value).toBe(3);
            expect(resultV2.meta_events[0].source).toBe("A");

            await db.close();
        });

        test("recomputes when stored input list doesn't match current schema", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            // Setup with schema
            const graphDef = [
                {
                    output: "sourceA",
                    inputs: [],
                    computor: async () => ({ value: 10 }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "sourceB",
                    inputs: [],
                    computor: async () => ({ value: 20 }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "derived",
                    inputs: ["sourceA"],
                    computor: async (inputs) => ({ value: inputs[0].value * 2 }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeDependencyGraph(db, graphDef);
            await graph.set("sourceA", { value: 10 });
            await graph.set("sourceB", { value: 20 });
            await graph.pull("derived");

            // Manually corrupt the InputsRecord to have wrong inputs
            // This simulates a database corruption or bug scenario
            const storage = graph.getStorage();
            const derivedKey = toJsonKey("derived", []);
            
            // Corrupt the InputsRecord to point to sourceB instead of sourceA
            await storage.inputs.put(derivedKey, {
                inputs: [toJsonKey("sourceB", [])], // Wrong input!
                inputCounters: [1]
            });
            
            // Mark derived as potentially-outdated to trigger validation
            await storage.freshness.put(derivedKey, "potentially-outdated");

            // When pulling, system should detect mismatch, skip counter optimization,
            // and recompute with correct inputs from schema (sourceA)
            const result = await graph.pull("derived");
            
            // Result should be correct: sourceA (10) * 2 = 20
            // Not sourceB (20) * 2 = 40
            expect(result.value).toBe(20);

            await db.close();
        });
    });
});
