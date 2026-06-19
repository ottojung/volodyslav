/**
 * Tests for batch consistency in incremental graph.
 * These tests verify that reads within a batch are consistent with pending writes/deletes.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { getRootDatabase } = require("../src/generators/incremental_graph/database");
const { makeIncrementalGraph } = require("../src/generators/incremental_graph");
const { getMockedRootCapabilities } = require("./spies");
const { makeSemanticStorage } = require("./test_database_helper");
const { stubLogger, stubEnvironment } = require("./stubs");

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
        path.join(os.tmpdir(), "incremental-graph-batch-consistency-")
    );

    stubLogger(capabilities);
    stubEnvironment(capabilities);
    return { ...capabilities, tmpDir };
}

describe("incremental_graph batch consistency", () => {
    describe("Generic batch consistency for all sublevels", () => {
        describe("values sublevel", () => {
            test("read-your-writes: get returns value written in same batch", async () => {
                const capabilities = getTestCapabilities();
                const db = await getRootDatabase(capabilities);

                const graphDef = [
                    {
                        output: "source",
                        inputs: [],
                        computor: () => ({ type: "all_events", events: [] }),
                        isDeterministic: true,
                        hasSideEffects: false,
                    },
                ];

                const graph = makeIncrementalGraph(capabilities, db, graphDef);
                const storage = makeSemanticStorage(graph);

                const testKey = '{"head":"source","args":[]}';
                const testValue = { type: "all_events", events: [{ id: "test" }] };

                let readValue;
                await storage.withBatch(async (batch) => {
                    // Write value
                    batch.values.put(testKey, testValue);
                    // Read it back in the same batch
                    readValue = await batch.values.get(testKey);
                });

                expect(readValue).toEqual(testValue);
                await db.close();
            });

            test("read-your-deletes: get returns undefined after delete in same batch", async () => {
                const capabilities = getTestCapabilities();
                const db = await getRootDatabase(capabilities);

                const graphDef = [
                    {
                        output: "source",
                        inputs: [],
                        computor: () => ({ type: "all_events", events: [] }),
                        isDeterministic: true,
                        hasSideEffects: false,
                    },
                ];

                const graph = makeIncrementalGraph(capabilities, db, graphDef);
                const storage = makeSemanticStorage(graph);

                const testKey = '{"head":"source","args":[]}';
                const testValue = { type: "all_events", events: [{ id: "test" }] };

                // First, write and commit
                await storage.withBatch(async (batch) => {
                    batch.values.put(testKey, testValue);
                });

                // Then delete and read in same batch
                let readValue;
                await storage.withBatch(async (batch) => {
                    batch.values.del(testKey);
                    readValue = await batch.values.get(testKey);
                });

                expect(readValue).toBeUndefined();
                await db.close();
            });

            test("delete-then-put: get returns new value after delete and put in same batch", async () => {
                const capabilities = getTestCapabilities();
                const db = await getRootDatabase(capabilities);

                const graphDef = [
                    {
                        output: "source",
                        inputs: [],
                        computor: () => ({ type: "all_events", events: [] }),
                        isDeterministic: true,
                        hasSideEffects: false,
                    },
                ];

                const graph = makeIncrementalGraph(capabilities, db, graphDef);
                const storage = makeSemanticStorage(graph);

                const testKey = '{"head":"source","args":[]}';
                const oldValue = { type: "all_events", events: [{ id: "old" }] };
                const newValue = { type: "all_events", events: [{ id: "new" }] };

                // First, write and commit old value
                await storage.withBatch(async (batch) => {
                    batch.values.put(testKey, oldValue);
                });

                // Then delete, put new value, and read in same batch
                let readValue;
                await storage.withBatch(async (batch) => {
                    batch.values.del(testKey);
                    batch.values.put(testKey, newValue);
                    readValue = await batch.values.get(testKey);
                });

                expect(readValue).toEqual(newValue);
                await db.close();
            });
        });

        describe("freshness sublevel", () => {
            test("read-your-writes: get returns freshness written in same batch", async () => {
                const capabilities = getTestCapabilities();
                const db = await getRootDatabase(capabilities);

                const graphDef = [
                    {
                        output: "source",
                        inputs: [],
                        computor: () => ({ type: "all_events", events: [] }),
                        isDeterministic: true,
                        hasSideEffects: false,
                    },
                ];

                const graph = makeIncrementalGraph(capabilities, db, graphDef);
                const storage = makeSemanticStorage(graph);

                const testKey = '{"head":"source","args":[]}';

                let readValue;
                await storage.withBatch(async (batch) => {
                    batch.freshness.put(testKey, "up-to-date");
                    readValue = await batch.freshness.get(testKey);
                });

                expect(readValue).toBe("up-to-date");
                await db.close();
            });

            test("read-your-deletes: get returns undefined after delete in same batch", async () => {
                const capabilities = getTestCapabilities();
                const db = await getRootDatabase(capabilities);

                const graphDef = [
                    {
                        output: "source",
                        inputs: [],
                        computor: () => ({ type: "all_events", events: [] }),
                        isDeterministic: true,
                        hasSideEffects: false,
                    },
                ];

                const graph = makeIncrementalGraph(capabilities, db, graphDef);
                const storage = makeSemanticStorage(graph);

                const testKey = '{"head":"source","args":[]}';

                // First, write and commit
                await storage.withBatch(async (batch) => {
                    batch.freshness.put(testKey, "up-to-date");
                });

                // Then delete and read in same batch
                let readValue;
                await storage.withBatch(async (batch) => {
                    batch.freshness.del(testKey);
                    readValue = await batch.freshness.get(testKey);
                });

                expect(readValue).toBeUndefined();
                await db.close();
            });
        });

        describe("valid sublevel", () => {
            test("read-your-writes: get returns valid written in same batch", async () => {
                const capabilities = getTestCapabilities();
                const db = await getRootDatabase(capabilities);

                const graphDef = [
                    {
                        output: "derived",
                        inputs: ["source"],
                        computor: () => ({ type: "meta_events", meta_events: [] }),
                        isDeterministic: true,
                        hasSideEffects: false,
                    },
                    {
                        output: "source",
                        inputs: [],
                        computor: () => ({ type: "all_events", events: [] }),
                        isDeterministic: true,
                        hasSideEffects: false,
                    },
                ];

                const graph = makeIncrementalGraph(capabilities, db, graphDef);
                const storage = makeSemanticStorage(graph);

                const inputKey = '{"head":"source","args":[]}';
                const dependents = ['{"head":"derived","args":[]}'];

                let readValue;
                await storage.withBatch(async (batch) => {
                    batch.valid.put(inputKey, dependents);
                    readValue = await batch.valid.get(inputKey);
                });

                expect(readValue).toEqual(dependents);
                await db.close();
            });
        });
    });

    describe("Regression tests for lost updates", () => {
        test("valid should not lose updates when two dependents added in same batch", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const graphDef = [
                {
                    output: "source",
                    inputs: [],
                    computor: () => ({ type: "all_events", events: [] }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "dependentA(x)",
                    inputs: ["source"],
                    computor: () => ({ type: "meta_events", meta_events: [] }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "dependentB(y)",
                    inputs: ["source"],
                    computor: () => ({ type: "meta_events", meta_events: [] }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeIncrementalGraph(capabilities, db, graphDef);
            const storage = makeSemanticStorage(graph);

            const inputKey = '{"head":"source","args":[]}';
            const dependentA = '{"head":"dependentA","args":["val1"]}';
            const dependentB = '{"head":"dependentB","args":["val2"]}';

            await storage.withBatch(async (batch) => {
                batch.valid.put(inputKey, [dependentA, dependentB]);
            });

            let dependents;
            await storage.withBatch(async (batch) => {
                dependents = await storage.listValidDependents(inputKey, batch);
            });
            expect(dependents).toContain(dependentA);
            expect(dependents).toContain(dependentB);
            expect(dependents.length).toBe(2);

            await db.close();
        });

    });
});
