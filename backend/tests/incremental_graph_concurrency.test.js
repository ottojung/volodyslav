/**
 * Tests for IncrementalGraph concurrency safety.
 * These tests verify that the graph handles concurrent operations correctly
 * and prevents race conditions between invalidate() and pull() operations.
 */

const {
    makeIncrementalGraph,
} = require("../src/generators/incremental_graph");
const { getMockedRootCapabilities } = require("./spies");

const testCapabilities = getMockedRootCapabilities();

/**
 * Deep clone helper for test data
 * @template T
 * @param {T} obj
 * @returns {T}
 */
function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

/**
 * Minimal in-memory Database that matches the RootDatabase interface.
 */
const DEFAULT_SCHEMA_KEY = '__default__';
class InMemoryDatabase {
    constructor() {
        /** @type {Map<string, Map<string, any>>} */
        this.schemas = new Map();
        /** @type {boolean} */
        this.closed = false;
        /** @type {string} */
        this.version = 'test-version';
    }

    getSchemaStorage() {
        const key = DEFAULT_SCHEMA_KEY;
        if (!this.schemas.has(key)) {
            this.schemas.set(key, new Map());
        }
        const schemaMap = this.schemas.get(key);

        const createSublevel = (name) => {
            const prefix = `${name}:`;
            const sublevel = {
                get: async (key) => {
                    const fullKey = prefix + key;
                    const v = schemaMap.get(fullKey);
                    return v === undefined ? undefined : deepClone(v);
                },
                put: async (key, value) => {
                    const fullKey = prefix + key;
                    schemaMap.set(fullKey, deepClone(value));
                },
                del: async (key) => {
                    const fullKey = prefix + key;
                    schemaMap.delete(fullKey);
                },
                putOp: (key, value) => {
                    return { type: "put", sublevel, key, value };
                },
                delOp: (key) => {
                    return { type: "del", sublevel, key };
                },
                keys: async function* () {
                    for (const k of schemaMap.keys()) {
                        if (k.startsWith(prefix)) {
                            yield k.substring(prefix.length);
                        }
                    }
                },
                clear: async () => {
                    const toDelete = [];
                    for (const k of schemaMap.keys()) {
                        if (k.startsWith(prefix)) {
                            toDelete.push(k);
                        }
                    }
                    for (const k of toDelete) {
                        schemaMap.delete(k);
                    }
                },
            };
            return sublevel;
        };

        const values = createSublevel("values");
        const freshness = createSublevel("freshness");
        const inputs = createSublevel("inputs");
        const revdeps = createSublevel("revdeps");
        const counters = createSublevel("counters");
        const timestamps = createSublevel("timestamps");

        return {
            values,
            freshness,
            inputs,
            revdeps,
            counters,
            timestamps,
            batch: async (operations) => {
                for (const op of operations) {
                    if (op.type === "put") {
                        await op.sublevel.put(op.key, op.value);
                    } else if (op.type === "del") {
                        await op.sublevel.del(op.key);
                    }
                }
            },
        };
    }

    async close() {
        this.closed = true;
    }
}

describe("IncrementalGraph concurrency", () => {
    describe("concurrent invalidate() operations", () => {
        test("multiple invalidate() calls on same node are serialized", async () => {
            const db = new InMemoryDatabase();
            const sourceCell = { value: { type: "test", value: 0 } };

            const graph = makeIncrementalGraph(testCapabilities, db, [
                {
                    output: "source",
                    inputs: [],
                    computor: async () => {
                        return sourceCell.value;
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ]);

            // Track the order of operations
            const operationLog = [];

            // Create multiple concurrent invalidate operations
            const promises = [];
            for (let i = 0; i < 10; i++) {
                const value = { type: "test", value: i };
                promises.push(
                    (async () => {
                        sourceCell.value = value;
                        await graph.invalidate("source");
                        operationLog.push(i);
                    })()
                );
            }

            await Promise.all(promises);

            // Verify all operations completed
            expect(operationLog).toHaveLength(10);

            // The final value should be one of the set values
            const result = await graph.pull("source");
            expect(result.type).toBe("test");
            expect(result.value).toBeGreaterThanOrEqual(0);
            expect(result.value).toBeLessThan(10);
        });

        test("concurrent invalidate() on different nodes works correctly", async () => {
            const db = new InMemoryDatabase();
            const source1Cell = { value: { type: "test", value: 0 } };
            const source2Cell = { value: { type: "test", value: 0 } };

            const graph = makeIncrementalGraph(testCapabilities, db, [
                {
                    output: "source1",
                    inputs: [],
                    computor: async () => {
                        return source1Cell.value;
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "source2",
                    inputs: [],
                    computor: async () => {
                        return source2Cell.value;
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ]);

            // Invalidate different nodes concurrently
            source1Cell.value = { type: "test", value: 1 };
            source2Cell.value = { type: "test", value: 2 };
            await Promise.all([
                graph.invalidate("source1"),
                graph.invalidate("source2"),
            ]);

            // Verify both values were set correctly
            const result1 = await graph.pull("source1");
            const result2 = await graph.pull("source2");

            expect(result1.value).toBe(1);
            expect(result2.value).toBe(2);
        });
    });

    describe("concurrent pull() operations", () => {
        test("multiple pull() calls on same node are serialized", async () => {
            const db = new InMemoryDatabase();
            let computeCount = 0;
            const sourceCell = { value: { type: "test", value: 5 } };

            const graph = makeIncrementalGraph(testCapabilities, db, [
                {
                    output: "source",
                    inputs: [],
                    computor: async () => {
                        return sourceCell.value;
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "derived",
                    inputs: ["source"],
                    computor: async ([source]) => {
                        computeCount++;
                        // Simulate some async work
                        await new Promise((resolve) =>
                            setTimeout(resolve, 10)
                        );
                        return { type: "derived", value: source.value * 2 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ]);

            // Invalidate source value
            sourceCell.value = { type: "test", value: 5 };
            await graph.invalidate("source");

            // Create multiple concurrent pull operations
            const promises = [];
            for (let i = 0; i < 10; i++) {
                promises.push(graph.pull("derived"));
            }

            const results = await Promise.all(promises);

            // All results should be the same
            expect(results).toHaveLength(10);
            for (const result of results) {
                expect(result.value).toBe(10);
            }

            expect(computeCount).toBe(1);
        });

        test("concurrent pull() on different nodes works correctly", async () => {
            const db = new InMemoryDatabase();
            const source1Cell = { value: { type: "test", value: 1 } };
            const source2Cell = { value: { type: "test", value: 2 } };

            const graph = makeIncrementalGraph(testCapabilities, db, [
                {
                    output: "source1",
                    inputs: [],
                    computor: async () => {
                        return source1Cell.value;
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "source2",
                    inputs: [],
                    computor: async () => {
                        return source2Cell.value;
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ]);

            // Invalidate source values
            source1Cell.value = { type: "test", value: 1 };
            await graph.invalidate("source1");
            source2Cell.value = { type: "test", value: 2 };
            await graph.invalidate("source2");

            // Pull different nodes concurrently
            const [result1, result2] = await Promise.all([
                graph.pull("source1"),
                graph.pull("source2"),
            ]);

            expect(result1.value).toBe(1);
            expect(result2.value).toBe(2);
        });
    });

    describe("concurrent invalidate() and pull() operations", () => {
        test("concurrent invalidate() and pull() on same node are serialized", async () => {
            const db = new InMemoryDatabase();
            const sourceCell = { value: { type: "test", value: 0 } };

            const graph = makeIncrementalGraph(testCapabilities, db, [
                {
                    output: "source",
                    inputs: [],
                    computor: async () => {
                        return sourceCell.value;
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ]);

            // Initial value
            sourceCell.value = { type: "test", value: 0 };
            await graph.invalidate("source");

            // Concurrent invalidate and pull operations
            const operations = [];
            for (let i = 0; i < 5; i++) {
                operations.push(
                    (async () => {
                        sourceCell.value = { type: "test", value: i };
                        await graph.invalidate("source");
                    })()
                );
                operations.push(graph.pull("source"));
            }

            const results = await Promise.all(operations);

            // Filter out undefined (from invalidate operations)
            const pullResults = results.filter((r) => r !== undefined);

            // All pull results should be valid
            expect(pullResults.length).toBeGreaterThan(0);
            for (const result of pullResults) {
                expect(result.type).toBe("test");
                expect(result.value).toBeGreaterThanOrEqual(0);
                expect(result.value).toBeLessThan(5);
            }
        });

        test("invalidate() on source invalidates dependent nodes correctly with concurrent pulls", async () => {
            const db = new InMemoryDatabase();
            let computeCount = 0;
            const sourceCell = { value: { type: "test", value: 5 } };

            const graph = makeIncrementalGraph(testCapabilities, db, [
                {
                    output: "source",
                    inputs: [],
                    computor: async () => {
                        return sourceCell.value;
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "derived",
                    inputs: ["source"],
                    computor: async ([source]) => {
                        computeCount++;
                        return { type: "derived", value: source.value * 2 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ]);

            // Set initial value
            sourceCell.value = { type: "test", value: 5 };
            await graph.invalidate("source");

            // Pull derived to compute it
            const result1 = await graph.pull("derived");
            expect(result1.value).toBe(10);
            expect(computeCount).toBe(1);

            // Reset compute count
            computeCount = 0;

            // Concurrent operations: update source and pull derived
            await Promise.all([
                (async () => {
                    sourceCell.value = { type: "test", value: 10 };
                    await graph.invalidate("source");
                })(),
                graph.pull("derived"),
                graph.pull("derived"),
            ]);

            // Pull again to ensure we get the updated value
            const result2 = await graph.pull("derived");
            expect(result2.value).toBe(20);

            // Computor should have been called at least once for the new value
            expect(computeCount).toBeGreaterThanOrEqual(1);
        });

        test("concurrent invalidate-pull cycles maintain consistency", async () => {
            const db = new InMemoryDatabase();
            const counterCell = { value: { type: "test", value: 0 } };

            const graph = makeIncrementalGraph(testCapabilities, db, [
                {
                    output: "counter",
                    inputs: [],
                    computor: async () => {
                        return counterCell.value;
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "doubled",
                    inputs: ["counter"],
                    computor: async ([counter]) => {
                        return { type: "derived", value: counter.value * 2 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ]);

            // Initial value
            counterCell.value = { type: "test", value: 0 };
            await graph.invalidate("counter");

            // Simulate concurrent async operations doing increment + read cycles
            const cycles = [];
            for (let i = 1; i <= 5; i++) {
                cycles.push(
                    (async () => {
                        counterCell.value = { type: "test", value: i };
                        await graph.invalidate("counter");
                        const doubled = await graph.pull("doubled");
                        // The doubled value should be consistent with some counter value
                        expect(doubled.value).toBeGreaterThanOrEqual(0);
                        expect(doubled.value % 2).toBe(0);
                        return doubled;
                    })()
                );
            }

            const results = await Promise.all(cycles);

            // All results should be valid doubles
            expect(results).toHaveLength(5);
            for (const result of results) {
                expect(result.type).toBe("derived");
                expect(result.value % 2).toBe(0);
            }
        });
    });

    describe("complex dependency chains with concurrency", () => {
        test("concurrent operations on complex graph maintain consistency", async () => {
            const db = new InMemoryDatabase();
            const aCell = { value: { type: "test", value: 1 } };
            const bCell = { value: { type: "test", value: 2 } };

            const graph = makeIncrementalGraph(testCapabilities, db, [
                {
                    output: "a",
                    inputs: [],
                    computor: async () => {
                        return aCell.value;
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "b",
                    inputs: [],
                    computor: async () => {
                        return bCell.value;
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "c",
                    inputs: ["a", "b"],
                    computor: async ([a, b]) => {
                        return { type: "sum", value: a.value + b.value };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "d",
                    inputs: ["c"],
                    computor: async ([c]) => {
                        return { type: "doubled", value: c.value * 2 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ]);

            // Set initial values
            aCell.value = { type: "test", value: 1 };
            await graph.invalidate("a");
            bCell.value = { type: "test", value: 2 };
            await graph.invalidate("b");

            // Concurrent operations
            await Promise.all([
                graph.pull("c"),
                graph.pull("d"),
                (async () => {
                    aCell.value = { type: "test", value: 5 };
                    await graph.invalidate("a");
                })(),
                graph.pull("c"),
                (async () => {
                    bCell.value = { type: "test", value: 10 };
                    await graph.invalidate("b");
                })(),
                graph.pull("d"),
            ]);

            // Final pull to check consistency
            const finalC = await graph.pull("c");
            const finalD = await graph.pull("d");

            // c should be a + b
            expect(finalC.value).toBe(15); // 5 + 10

            // d should be c * 2
            expect(finalD.value).toBe(30); // 15 * 2
        });
    });

    describe("locking design semantics", () => {
        /**
         * @template T
         * @returns {{ promise: Promise<T>, resolve: (value: T) => void }}
         */
        function makeDeferred() {
            /** @type {(value: T) => void} */
            let resolve = () => undefined;
            const promise = new Promise((resolveCallback) => {
                resolve = resolveCallback;
            });
            return { promise, resolve };
        }

        test("concurrent invalidates can overlap (observe mode is shared)", async () => {
            const capabilities = getMockedRootCapabilities();
            const db = new InMemoryDatabase();
            const source1Cell = { value: { type: "test", value: 1 } };
            const source2Cell = { value: { type: "test", value: 2 } };

            const graph = makeIncrementalGraph(capabilities, db, [
                {
                    output: "source1",
                    inputs: [],
                    computor: async () => source1Cell.value,
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "source2",
                    inputs: [],
                    computor: async () => source2Cell.value,
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ]);

            const releaseBoth = makeDeferred();
            let active = 0;
            let maxActive = 0;
            const originalWithBatch = graph.storage.withBatch.bind(graph.storage);
            graph.storage.withBatch = async (run) => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                await releaseBoth.promise;
                try {
                    return await originalWithBatch(run);
                } finally {
                    active -= 1;
                }
            };

            const invalidate1 = graph.invalidate("source1");
            const invalidate2 = graph.invalidate("source2");
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(maxActive).toBe(2);

            releaseBoth.resolve(undefined);
            await Promise.all([invalidate1, invalidate2]);
        });

        test("inspection reads can run while invalidate is in progress", async () => {
            const capabilities = getMockedRootCapabilities();
            const db = new InMemoryDatabase();
            const sourceCell = { value: { type: "test", value: 1 } };

            const graph = makeIncrementalGraph(capabilities, db, [
                {
                    output: "source",
                    inputs: [],
                    computor: async () => sourceCell.value,
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ]);

            const releaseInvalidate = makeDeferred();
            const enteredInvalidate = makeDeferred();
            const originalWithBatch = graph.storage.withBatch.bind(graph.storage);
            graph.storage.withBatch = async (run) => {
                enteredInvalidate.resolve(undefined);
                await releaseInvalidate.promise;
                return await originalWithBatch(run);
            };

            const invalidatePromise = graph.invalidate("source");
            await enteredInvalidate.promise;

            let inspectionCompleted = false;
            const inspectionPromise = graph
                .debugListMaterializedNodes()
                .then(() => {
                    inspectionCompleted = true;
                });
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(inspectionCompleted).toBe(true);

            releaseInvalidate.resolve(undefined);
            await invalidatePromise;
            await inspectionPromise;
        });

        test("pull blocks invalidate and inspection reads", async () => {
            const capabilities = getMockedRootCapabilities();
            const db = new InMemoryDatabase();
            const sourceCell = { value: { type: "test", value: 1 } };
            const pullStarted = makeDeferred();
            const releasePull = makeDeferred();

            const graph = makeIncrementalGraph(capabilities, db, [
                {
                    output: "source",
                    inputs: [],
                    computor: async () => {
                        pullStarted.resolve(undefined);
                        await releasePull.promise;
                        return sourceCell.value;
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ]);

            const pullPromise = graph.pull("source");
            await pullStarted.promise;

            let invalidateDone = false;
            let inspectDone = false;
            const invalidatePromise = graph.invalidate("source").then(() => {
                invalidateDone = true;
            });
            const inspectPromise = graph.debugGetValue("source").then(() => {
                inspectDone = true;
            });
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(invalidateDone).toBe(false);
            expect(inspectDone).toBe(false);

            releasePull.resolve(undefined);
            await pullPromise;
            await invalidatePromise;
            await inspectPromise;
        });

        test("concurrent pulls on the same node are serialized", async () => {
            const capabilities = getMockedRootCapabilities();
            const db = new InMemoryDatabase();
            const sourceCell = { value: { type: "test", value: 1 } };
            let activeComputations = 0;
            let maxActiveComputations = 0;

            const graph = makeIncrementalGraph(capabilities, db, [
                {
                    output: "source",
                    inputs: [],
                    computor: async () => {
                        activeComputations += 1;
                        maxActiveComputations = Math.max(
                            maxActiveComputations,
                            activeComputations
                        );
                        await new Promise((resolve) => setTimeout(resolve, 20));
                        activeComputations -= 1;
                        return sourceCell.value;
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ]);

            await Promise.all([
                graph.pull("source"),
                graph.pull("source"),
                graph.pull("source"),
            ]);

            expect(maxActiveComputations).toBe(1);
        });

        test("concurrent pulls on different nodes can overlap", async () => {
            const capabilities = getMockedRootCapabilities();
            const db = new InMemoryDatabase();
            const source1Cell = { value: { type: "test", value: 1 } };
            const source2Cell = { value: { type: "test", value: 2 } };
            const releaseBoth = makeDeferred();
            const started = [];

            const graph = makeIncrementalGraph(capabilities, db, [
                {
                    output: "source1",
                    inputs: [],
                    computor: async () => {
                        started.push("source1");
                        await releaseBoth.promise;
                        return source1Cell.value;
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "source2",
                    inputs: [],
                    computor: async () => {
                        started.push("source2");
                        await releaseBoth.promise;
                        return source2Cell.value;
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ]);

            const pull1 = graph.pull("source1");
            const pull2 = graph.pull("source2");
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(started.sort()).toEqual(["source1", "source2"]);

            releaseBoth.resolve(undefined);
            await Promise.all([pull1, pull2]);
        });
    });
});
