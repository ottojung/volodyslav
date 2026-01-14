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
        test("Test 1: skips recomputation when input returns Unchanged (counter doesn't change)", async () => {
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

        test("Test 2: recomputes when input counter actually changed", async () => {
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

        test("Test 3: multi-input counter snapshot comparison", async () => {
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

        test("Test 4: enforces invariants - missing counter throws error", async () => {
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

        test("Test 4b: enforces invariants - missing inputCounters throws error", async () => {
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
    });
});
