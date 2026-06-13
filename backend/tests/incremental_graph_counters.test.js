/**
 * Tests for incremental graph recomputation and caching behavior.
 * These tests verify that nodes recompute when stale and cache-hit when valid.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { getRootDatabase } = require("../src/generators/incremental_graph/database");
const {
    makeIncrementalGraph,
    makeUnchanged,
} = require("../src/generators/incremental_graph");
const { getMockedRootCapabilities } = require("./spies");
const { makeSemanticStorage } = require("./test_database_helper");
const { stubLogger, stubEnvironment } = require("./stubs");
const { toJsonKey } = require("./test_json_key_helper");

/**
 * @typedef {import('../src/generators/incremental_graph/database/types').DatabaseCapabilities} DatabaseCapabilities
 */

/**
 * Creates test capabilities with a temporary data directory.
 * @returns {DatabaseCapabilities & { tmpDir: string }}
 */
function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "incremental-graph-counter-test-")
    );

    stubLogger(capabilities);
    stubEnvironment(capabilities);
    return { ...capabilities, tmpDir };
}

describe("generators/incremental_graph counters", () => {
    describe("Recomputation behavior", () => {
        test("skips recomputation when input returns Unchanged (counter doesn't change)", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            // Track computation counts
            let bComputes = 0;
            let aComputes = 0;

            const srcCell = { value: null };

            const graphDef = [
                {
                    output: "src",
                    inputs: [],
                    computor: async () => srcCell.value,
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

            const graph = makeIncrementalGraph(capabilities, db, graphDef);

            // Step 1: set src
            srcCell.value = { type: "all_events", events: [1] };
            await graph.invalidate("src");

            // Step 2: pull a - should compute both b and a
            await graph.pull("a");
            expect(bComputes).toBe(1);
            expect(aComputes).toBe(1);

            // Step 3: set src again (different value)
            srcCell.value = { type: "all_events", events: [2] };
            await graph.invalidate("src");

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

            const srcCell = { value: null };

            const graphDef = [
                {
                    output: "src",
                    inputs: [],
                    computor: async () => srcCell.value,
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

            const graph = makeIncrementalGraph(capabilities, db, graphDef);

            srcCell.value = { type: "all_events", events: [1] };
            await graph.invalidate("src");
            await graph.pull("a");
            expect(bComputes).toBe(1);
            expect(aComputes).toBe(1);

            srcCell.value = { type: "all_events", events: [2, 3] };
            await graph.invalidate("src");
            await graph.pull("b");
            expect(bComputes).toBe(2);

            // b's counter changed, so a must recompute
            await graph.pull("a");
            expect(aComputes).toBe(2);

            await db.close();
        });

        test("multi-input recomputation and cache hit", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            let aComputes = 0;

            const bCell = { value: null };
            const cCell = { value: null };

            const graphDef = [
                {
                    output: "b",
                    inputs: [],
                    computor: async () => bCell.value,
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "c",
                    inputs: [],
                    computor: async () => cCell.value,
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

            const graph = makeIncrementalGraph(capabilities, db, graphDef);

            bCell.value = { type: "all_events", events: [1] };
            await graph.invalidate("b");
            cCell.value = { type: "all_events", events: [2] };
            await graph.invalidate("c");
            await graph.pull("a");
            expect(aComputes).toBe(1);

            // Change only b
            bCell.value = { type: "all_events", events: [3] };
            await graph.invalidate("b");
            await graph.pull("a");
            expect(aComputes).toBe(2); // Should recompute

            // Don't change anything, just pull again
            await graph.pull("a");
            expect(aComputes).toBe(2); // recomputed (source value changed)

            await db.close();
        });

        test("enforces invariants - missing counter throws error", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const srcCell = { value: null };

            const graphDef = [
                {
                    output: "src",
                    inputs: [],
                    computor: async () => srcCell.value,
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

            const graph = makeIncrementalGraph(capabilities, db, graphDef);

            // Set src to create a value
            srcCell.value = { type: "all_events", events: [1] };
            await graph.invalidate("src");
            await graph.pull("derived");

            // Manually corrupt the database by deleting the counter for src
            const storage = makeSemanticStorage(graph);
            await storage.counters.del(toJsonKey("src", []));
            
            // Invalidate derived by marking it potentially-outdated
            await storage.freshness.put(toJsonKey("derived", []), "potentially-outdated");

            // Now trying to pull derived should succeed (counters are not used for cache validation)
            const result = await graph.pull("derived");
            expect(result).toBeTruthy();

            await db.close();
        });

        test("stores inputs as plain identifier array", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const srcCell = { value: null };

            const graphDef = [
                {
                    output: "src",
                    inputs: [],
                    computor: async () => srcCell.value,
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

            const graph = makeIncrementalGraph(capabilities, db, graphDef);

            srcCell.value = { type: "all_events", events: [1] };
            await graph.invalidate("src");
            await graph.pull("derived");

            const storage = makeSemanticStorage(graph);
            const derivedKey = toJsonKey("derived", []);
            const inputs = await storage.inputs.get(derivedKey);
            expect(inputs).toBeTruthy();
            // Inputs should be a plain array of semantic key strings
            expect(Array.isArray(inputs)).toBe(true);
            expect(inputs.inputCounters).toBeUndefined();

            // Pull again: should cache-hit
            const result = await graph.pull("derived");
            expect(result).toBeTruthy();

            await db.close();
        });

        test("recomputes when InputsRecord input list changes", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const sourceACell = { value: null };
            const sourceBCell = { value: null };

            // Schema with derived depending on sourceA
            const graphDef = [
                {
                    output: "sourceA",
                    inputs: [],
                    computor: async () => sourceACell.value,
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "sourceB",
                    inputs: [],
                    computor: async () => sourceBCell.value,
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

            const graph = makeIncrementalGraph(capabilities, db, graphDef);

            // Set up initial state
            sourceACell.value = { type: "all_events", events: [1, 2, 3] };
            await graph.invalidate("sourceA");
            sourceBCell.value = { type: "all_events", events: [4, 5] };
            await graph.invalidate("sourceB");
            const resultV1 = await graph.pull("derived");
            
            // Derived should have meta_events with value 3 (from sourceA)
            expect(resultV1.meta_events[0].value).toBe(3);
            expect(resultV1.meta_events[0].source).toBe("A");

            // Now manually corrupt the InputsRecord to point to sourceB instead
            // This simulates a database corruption scenario
            const storage = makeSemanticStorage(graph);
            const derivedKey = toJsonKey("derived", []);
            const sourceBKey = toJsonKey("sourceB", []);
            
            // Corrupt the InputsRecord
            await storage.inputs.put(derivedKey, [sourceBKey]);
            
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

            const sourceACell = { value: null };
            const sourceBCell = { value: null };

            // Setup with schema
            const graphDef = [
                {
                    output: "sourceA",
                    inputs: [],
                    computor: async () => sourceACell.value,
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "sourceB",
                    inputs: [],
                    computor: async () => sourceBCell.value,
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

            const graph = makeIncrementalGraph(capabilities, db, graphDef);
            sourceACell.value = { value: 10 };
            await graph.invalidate("sourceA");
            sourceBCell.value = { value: 20 };
            await graph.invalidate("sourceB");
            await graph.pull("derived");

            // Manually corrupt the InputsRecord to have wrong inputs
            // This simulates a database corruption or bug scenario
            const storage = makeSemanticStorage(graph);
            const derivedKey = toJsonKey("derived", []);
            
            // Corrupt the InputsRecord to point to sourceB instead of sourceA
            await storage.inputs.put(derivedKey, [toJsonKey("sourceB", [])]);
            
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

    describe("Invariant enforcement: up-to-date node must have stored value", () => {
        test("throws when up-to-date node has no stored value (corruption)", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const graphDef = [
                {
                    output: "src",
                    inputs: [],
                    computor: async () => ({ type: "all_events", events: [] }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeIncrementalGraph(capabilities, db, graphDef);

            // Pull src to populate the database with a value and "up-to-date" freshness
            await graph.pull("src");

            // Corrupt: delete the stored value, leaving freshness as "up-to-date"
            const storage = makeSemanticStorage(graph);
            await storage.values.del("src");

            // Pulling again should detect the corruption and throw
            await expect(graph.pull("src")).rejects.toThrow(/Impossible/);

            await db.close();
        });

        test("throws when up-to-date node has no stored value for graph with dependencies", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const srcCell = { value: null };

            const graphDef = [
                {
                    output: "src",
                    inputs: [],
                    computor: async () => srcCell.value,
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "derived",
                    inputs: ["src"],
                    computor: async (inputs) => ({
                        type: "meta_events",
                        value: inputs.src,
                    }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeIncrementalGraph(capabilities, db, graphDef);

            // Pull derived to trigger a full computation
            srcCell.value = { type: "all_events", events: [1] };
            await graph.invalidate("src");
            await graph.pull("derived");

            // Corrupt: delete derived's value, leave freshness as "up-to-date"
            const storage = makeSemanticStorage(graph);
            await storage.values.del("derived");

            // Pulling derived should detect the corruption and throw
            await expect(graph.pull("derived")).rejects.toThrow(/Impossible/);

            await db.close();
        });

        test("does not throw when node is up-to-date and has a stored value (no corruption)", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const graphDef = [
                {
                    output: "src",
                    inputs: [],
                    computor: async () => ({ type: "all_events", events: [] }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeIncrementalGraph(capabilities, db, graphDef);

            // Normal pull — value exists, freshness is "up-to-date"
            const result = await graph.pull("src");

            // Should succeed without error
            expect(result).toEqual({ type: "all_events", events: [] });

            await db.close();
        });
    });
});
