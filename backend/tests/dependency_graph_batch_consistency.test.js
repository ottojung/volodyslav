/**
 * Tests for batch consistency in dependency graph.
 * These tests verify that reads within a batch are consistent with pending writes/deletes.
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
        path.join(os.tmpdir(), "dependency-graph-batch-consistency-")
    );

    stubLogger(capabilities);

    // Override environment to use temp directory
    capabilities.environment = {
        pathToVolodyslavDataDirectory: jest.fn().mockReturnValue(tmpDir),
    };

    return { ...capabilities, tmpDir };
}

describe("dependency_graph batch consistency", () => {
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

                const graph = makeDependencyGraph(db, graphDef);
                const storage = graph.getStorage();

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

                const graph = makeDependencyGraph(db, graphDef);
                const storage = graph.getStorage();

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

                const graph = makeDependencyGraph(db, graphDef);
                const storage = graph.getStorage();

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

                const graph = makeDependencyGraph(db, graphDef);
                const storage = graph.getStorage();

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

                const graph = makeDependencyGraph(db, graphDef);
                const storage = graph.getStorage();

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

        describe("inputs sublevel", () => {
            test("read-your-writes: get returns inputs written in same batch", async () => {
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

                const graph = makeDependencyGraph(db, graphDef);
                const storage = graph.getStorage();

                const testKey = '{"head":"derived","args":[]}';
                const testValue = { inputs: ['{"head":"source","args":[]}'] };

                let readValue;
                await storage.withBatch(async (batch) => {
                    batch.inputs.put(testKey, testValue);
                    readValue = await batch.inputs.get(testKey);
                });

                expect(readValue).toEqual(testValue);
                await db.close();
            });
        });

        describe("revdeps sublevel", () => {
            test("read-your-writes: get returns revdeps written in same batch", async () => {
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

                const graph = makeDependencyGraph(db, graphDef);
                const storage = graph.getStorage();

                const inputKey = '{"head":"source","args":[]}';
                const dependents = ['{"head":"derived","args":[]}'];

                let readValue;
                await storage.withBatch(async (batch) => {
                    batch.revdeps.put(inputKey, dependents);
                    readValue = await batch.revdeps.get(inputKey);
                });

                expect(readValue).toEqual(dependents);
                await db.close();
            });
        });
    });

    describe("Regression tests for lost updates", () => {
        test("revdeps should not lose updates when two dependents added in same batch", async () => {
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

            const graph = makeDependencyGraph(db, graphDef);
            const storage = graph.getStorage();

            const inputKey = '{"head":"source","args":[]}';
            const dependentA = '{"head":"dependentA","args":["val1"]}';
            const dependentB = '{"head":"dependentB","args":["val2"]}';

            // Add two dependents in the same batch
            await storage.withBatch(async (batch) => {
                await storage.ensureReverseDepsIndexed(dependentA, [inputKey], batch);
                await storage.ensureReverseDepsIndexed(dependentB, [inputKey], batch);
            });

            // After commit, both should be present
            let dependents;
            await storage.withBatch(async (batch) => {
                dependents = await storage.listDependents(inputKey, batch);
            });
            expect(dependents).toContain(dependentA);
            expect(dependents).toContain(dependentB);
            expect(dependents.length).toBe(2);

            await db.close();
        });

        test("inputs should not be overwritten by stale reads in same batch", async () => {
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
                    output: "derived",
                    inputs: ["source"],
                    computor: () => ({ type: "meta_events", meta_events: [] }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeDependencyGraph(db, graphDef);
            const storage = graph.getStorage();

            const nodeKey = '{"head":"derived","args":[]}';
            const inputA = '{"head":"source","args":["A"]}';
            const inputB = '{"head":"source","args":["B"]}';

            await storage.withBatch(async (batch) => {
                // First stage inputs with inputA
                batch.inputs.put(nodeKey, { inputs: [inputA], inputCounters: [1] });

                // Then call ensureMaterialized with inputB
                // With the new implementation, this WILL overwrite (always writes)
                await storage.ensureMaterialized(nodeKey, [inputB], [2], batch);
            });

            // After commit, should have inputB (the last write), not inputA
            // This is different from the old behavior where it wouldn't overwrite
            let inputs;
            await storage.withBatch(async (batch) => {
                inputs = await storage.getInputs(nodeKey, batch);
            });
            expect(inputs).toEqual([inputB]);

            await db.close();
        });
    });
});
