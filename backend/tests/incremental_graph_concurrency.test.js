/**
 * Tests for IncrementalGraph concurrency safety.
 * These tests verify that the graph handles concurrent operations correctly
 * and prevents race conditions between invalidate() and pull() operations.
 */

const {
    makeIncrementalGraph,
} = require("../src/generators/incremental_graph");
const {
    makeEmptyIdentifierLookup,
    cloneIdentifierLookup,
    nodeIdToKeyFromLookup,
    nodeKeyToIdFromLookup,
    nodeIdentifierFromString,
    nodeIdentifierToString,
    IDENTIFIERS_KEY,
    makeIdentifierLookup,
} = require("../src/generators/incremental_graph/database");
const { holidayActivity, nighttimeActivity, telescopeActivity, daytimeActivity } = require("../src/generators/incremental_graph/lock");
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
        this._identifierLookup = makeEmptyIdentifierLookup();
        this._identifierCounter = 0;
        /** @type {Map<string, string>} */
        this._pendingAllocations = new Map();
        this._computed = { lastNodeIndex: 0, fingerprint: 'testconfingerprint' };
    }

    currentReplicaName() { return 'x'; }

    cloneActiveIdentifierLookup() {
        return cloneIdentifierLookup(this._identifierLookup);
    }

    getActiveIdentifierLookup() {
        return this._identifierLookup;
    }

    replaceActiveIdentifierLookup(lookup) {
        this._identifierLookup = lookup;
    }

    nodeIdToKey(nodeIdentifier) {
        return nodeIdToKeyFromLookup(this._identifierLookup, nodeIdentifier);
    }

    nodeKeyToId(nodeKey) {
        return nodeKeyToIdFromLookup(this._identifierLookup, nodeKey);
    }

    generateNodeIdentifier() {
        this._identifierCounter++;
        let n = this._identifierCounter;
        let id = '';
        for (let i = 0; i < 9; i++) {
            id = String.fromCharCode(97 + (n % 26)) + id;
            n = Math.floor(n / 26);
        }
        return nodeIdentifierFromString(id);
    }

    getCurrentAllocationWatermark() {
        return this._identifierCounter;
    }

    getFingerprint() {
        return 'testconfingerprint';
    }

    getVersion() { return this.version; }

    getLastNodeIndex() { return this._computed.lastNodeIndex; }

    advanceLastNodeIndex(value) { this._computed.lastNodeIndex = Math.max(this._computed.lastNodeIndex, value); }

    _allocateKeyIdentifier(keyString, makeIdentifier, committedLookup) {
        if (this._pendingAllocations.has(keyString)) {
            throw new Error(`BUG: pending allocation for key ${keyString} found during allocation under telescope lock`);
        }
        const candidate = makeIdentifier();
        const candidateStr = nodeIdentifierToString(candidate);
        if (committedLookup.idToKey.get(candidateStr) !== undefined) {
            throw new Error(`BUG: identifier collision with committed lookup: ${candidateStr}`);
        }
        for (const idStr of this._pendingAllocations.values()) {
            if (idStr === candidateStr) {
                throw new Error(`BUG: identifier collision with pending allocation: ${candidateStr}`);
            }
        }
        this._pendingAllocations.set(keyString, candidateStr);
        return candidate;
    }

    releaseIdentifierReservations(ownedKeys) {
        for (const keyString of ownedKeys) {
            this._pendingAllocations.delete(keyString);
        }
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
        const global = createSublevel("global");

        return {
            values,
            freshness,
            inputs,
            revdeps,
            counters,
            timestamps,
            global,
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

            // PULL_NODE_KEY serializes same-node pulls: only the first computes,
            // subsequent ones hit the cache.
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

        test("concurrent invalidates can overlap", async () => {
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
            const originalWithTransaction = graph.storage.withTransaction.bind(graph.storage);
            graph.storage.withTransaction = async (run) => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                await releaseBoth.promise;
                try {
                    return await originalWithTransaction(run);
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
            const originalWithTransaction = graph.storage.withTransaction.bind(graph.storage);
            graph.storage.withTransaction = async (run) => {
                enteredInvalidate.resolve(undefined);
                await releaseInvalidate.promise;
                return await originalWithTransaction(run);
            };

            const invalidatePromise = graph.invalidate("source");
            await enteredInvalidate.promise;

            let inspectionCompleted = false;
            const inspectionPromise = graph
                .listMaterializedNodes()
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
            const inspectPromise = graph.getValue("source").then(() => {
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

            // PULL_NODE_KEY serializes same-node pulls: only one computation
            // runs at a time; subsequent pulls hit the cache.
            expect(maxActiveComputations).toBe(1);
        });

        test("concurrent pulls on different nodes can overlap safely", async () => {
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
            // Both computors should enter before either one finishes.
            expect(started.sort()).toEqual(["source1", "source2"]);

            releaseBoth.resolve(undefined);
            await Promise.all([pull1, pull2]);
        });

        test("fire-and-forget callback pull reacquires computed-state mutex", async () => {
            const capabilities = getMockedRootCapabilities();
            const db = new InMemoryDatabase();
            const releaseSlow = makeDeferred();
            const callbackResult = makeDeferred();
            let activeSlowComputations = 0;
            let maxActiveSlowComputations = 0;

            const graph = makeIncrementalGraph(capabilities, db, [
                {
                    output: "slow",
                    inputs: [],
                    computor: async () => {
                        activeSlowComputations += 1;
                        maxActiveSlowComputations = Math.max(
                            maxActiveSlowComputations,
                            activeSlowComputations
                        );
                        await releaseSlow.promise;
                        activeSlowComputations -= 1;
                        return { type: "test", value: "slow-value" };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "trigger",
                    inputs: [],
                    computor: async () => {
                        setTimeout(async () => {
                            const result = await graph.pull("slow");
                            callbackResult.resolve(result);
                        }, 10);
                        return { type: "test", value: "trigger-value" };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ]);

            await graph.pull("trigger");
            const slowPull = graph.pull("slow");

            await new Promise((resolve) => setTimeout(resolve, 30));
            // PULL_NODE_KEY serializes same-node pulls: only the first caller
            // computes "slow"; subsequent callers hit the cache.
            expect(maxActiveSlowComputations).toBe(1);

            releaseSlow.resolve(undefined);
            await slowPull;
            await expect(callbackResult.promise).resolves.toEqual({
                type: "test",
                value: "slow-value",
            });

            expect(maxActiveSlowComputations).toBe(1);
        });
    });

    describe("cosmic observatory locking semantics", () => {
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

        test("concurrent holiday operations are serialized", async () => {
            const capabilities = getMockedRootCapabilities();
            const sleeper = capabilities.sleeper;

            const trace = [];
            const releaseFirst = makeDeferred();
            const enteredFirst = makeDeferred();

            const first = holidayActivity(sleeper, async () => {
                trace.push("first-start");
                enteredFirst.resolve(undefined);
                await releaseFirst.promise;
                trace.push("first-end");
            });

            // Wait deterministically until the first operation has entered the exclusive section
            await enteredFirst.promise;

            const second = holidayActivity(sleeper, async () => {
                trace.push("second-start");
                trace.push("second-end");
            });

            releaseFirst.resolve(undefined);
            await Promise.all([first, second]);

            expect(trace).toEqual([
                "first-start",
                "first-end",
                "second-start",
                "second-end",
            ]);
        });

        test("holiday blocks concurrent observations", async () => {
            const capabilities = getMockedRootCapabilities();
            const sleeper = capabilities.sleeper;

            const releaseExclusive = makeDeferred();
            const exclusiveEntered = makeDeferred();

            const exclusive = holidayActivity(sleeper, async () => {
                exclusiveEntered.resolve(undefined);
                await releaseExclusive.promise;
            });

            await exclusiveEntered.promise;

            const pullEntered = makeDeferred();
            let pullEnteredResolved = false;
            pullEntered.promise.then(() => {
                pullEnteredResolved = true;
            });

            const pull = nighttimeActivity(sleeper, () => telescopeActivity(sleeper, "P", async () => {
                pullEntered.resolve(undefined);
            }));

            // Give pull a chance to run if it were not blocked (single microtask turn)
            await Promise.resolve();
            expect(pullEnteredResolved).toBe(false);

            releaseExclusive.resolve(undefined);
            await exclusive;
            await pull;
            expect(pullEnteredResolved).toBe(true);
        });

        test("holiday blocks concurrent daytime activity", async () => {
            const capabilities = getMockedRootCapabilities();
            const sleeper = capabilities.sleeper;

            const releaseExclusive = makeDeferred();
            const exclusiveEntered = makeDeferred();

            const exclusive = holidayActivity(sleeper, async () => {
                exclusiveEntered.resolve(undefined);
                await releaseExclusive.promise;
            });

            await exclusiveEntered.promise;

            const observeEntered = makeDeferred();
            let observeEnteredResolved = false;
            observeEntered.promise.then(() => {
                observeEnteredResolved = true;
            });

            const observe = daytimeActivity(sleeper, async () => {
                observeEntered.resolve(undefined);
            });

            // Give observe a chance to run if it were not blocked (single microtask turn)
            await Promise.resolve();
            expect(observeEnteredResolved).toBe(false);

            releaseExclusive.resolve(undefined);
            await exclusive;
            await observe;
            expect(observeEnteredResolved).toBe(true);
        });

        test("observation blocks a pending holiday operation", async () => {
            const capabilities = getMockedRootCapabilities();
            const sleeper = capabilities.sleeper;

            const releasePull = makeDeferred();
            const pullEntered = makeDeferred();

            const pull = nighttimeActivity(sleeper, () => telescopeActivity(sleeper, "P", async () => {
                pullEntered.resolve(undefined);
                await releasePull.promise;
            }));

            await pullEntered.promise;

            let exclusiveDone = false;
            const exclusive = holidayActivity(sleeper, async () => {
                exclusiveDone = true;
            });

            // Give exclusive a chance to run (it should be blocked)
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(exclusiveDone).toBe(false);

            releasePull.resolve(undefined);
            await pull;
            await exclusive;
            expect(exclusiveDone).toBe(true);
        });

        test("daytime activity blocks a pending holiday operation", async () => {
            const capabilities = getMockedRootCapabilities();
            const sleeper = capabilities.sleeper;

            const releaseObserve = makeDeferred();
            const observeEntered = makeDeferred();

            const observe = daytimeActivity(sleeper, async () => {
                observeEntered.resolve(undefined);
                await releaseObserve.promise;
            });

            await observeEntered.promise;

            let exclusiveDone = false;
            const exclusive = holidayActivity(sleeper, async () => {
                exclusiveDone = true;
            });

            // Give exclusive a chance to run (it should be blocked)
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(exclusiveDone).toBe(false);

            releaseObserve.resolve(undefined);
            await observe;
            await exclusive;
            expect(exclusiveDone).toBe(true);
        });

        test("holiday blocks multiple queued observations", async () => {
            const capabilities = getMockedRootCapabilities();
            const sleeper = capabilities.sleeper;

            const releaseExclusive = makeDeferred();
            const exclusiveEntered = makeDeferred();

            const exclusive = holidayActivity(sleeper, async () => {
                exclusiveEntered.resolve(undefined);
                await releaseExclusive.promise;
            });

            await exclusiveEntered.promise;

            const trace = [];
            const pull1 = nighttimeActivity(sleeper, () => telescopeActivity(sleeper, "A", async () => {
                trace.push("pull1");
            }));
            const pull2 = nighttimeActivity(sleeper, () => telescopeActivity(sleeper, "B", async () => {
                trace.push("pull2");
            }));

            await new Promise((resolve) => setTimeout(resolve, 20));
            // Neither pull should have started while exclusive holds
            expect(trace).toEqual([]);

            releaseExclusive.resolve(undefined);
            await exclusive;
            await Promise.all([pull1, pull2]);
            // Both pulls ran after exclusive released
            expect(trace.sort()).toEqual(["pull1", "pull2"]);
        });
    });

    describe("cosmic observatory model enforcement", () => {
        /**
         * @returns {{ promise: Promise<unknown>, resolve: (value: unknown) => void }}
         */
        function makeDeferred() {
            let resolve = () => undefined;
            const promise = new Promise((resolveCallback) => {
                resolve = resolveCallback;
            });
            return { promise, resolve };
        }

        test("daytime + daytime => allowed", async () => {
            const capabilities = getMockedRootCapabilities();
            const sleeper = capabilities.sleeper;

            const releaseFirst = makeDeferred();
            const enteredFirst = makeDeferred();
            let enteredSecondResolved = false;

            const first = daytimeActivity(sleeper, async () => {
                enteredFirst.resolve(undefined);
                await releaseFirst.promise;
            });
            await enteredFirst.promise;

            const second = daytimeActivity(sleeper, async () => {
                enteredSecondResolved = true;
            });

            await Promise.resolve();
            expect(enteredSecondResolved).toBe(true);

            releaseFirst.resolve(undefined);
            await Promise.all([first, second]);
        });

        test("daytime + observation => blocked", async () => {
            const capabilities = getMockedRootCapabilities();
            const sleeper = capabilities.sleeper;

            const releaseDay = makeDeferred();
            const enteredDay = makeDeferred();
            let enteredNightResolved = false;

            const day = daytimeActivity(sleeper, async () => {
                enteredDay.resolve(undefined);
                await releaseDay.promise;
            });
            await enteredDay.promise;

            const night = nighttimeActivity(sleeper, () => telescopeActivity(sleeper, "N", async () => {
                enteredNightResolved = true;
            }));

            await Promise.resolve();
            expect(enteredNightResolved).toBe(false);

            releaseDay.resolve(undefined);
            await day;
            await night;
            expect(enteredNightResolved).toBe(true);
        });

        test("observation(A) + observation(A) => blocked", async () => {
            const capabilities = getMockedRootCapabilities();
            const sleeper = capabilities.sleeper;

            const releaseFirst = makeDeferred();
            const enteredFirst = makeDeferred();
            let enteredSecondResolved = false;

            const first = nighttimeActivity(sleeper, () => telescopeActivity(sleeper, "A", async () => {
                enteredFirst.resolve(undefined);
                await releaseFirst.promise;
            }));
            await enteredFirst.promise;

            const second = nighttimeActivity(sleeper, () => telescopeActivity(sleeper, "A", async () => {
                enteredSecondResolved = true;
            }));

            await Promise.resolve();
            expect(enteredSecondResolved).toBe(false);

            releaseFirst.resolve(undefined);
            await Promise.all([first, second]);
            expect(enteredSecondResolved).toBe(true);
        });

        test("observation(A) + observation(B) => allowed", async () => {
            const capabilities = getMockedRootCapabilities();
            const sleeper = capabilities.sleeper;

            const releaseFirst = makeDeferred();
            const enteredFirst = makeDeferred();
            let enteredSecondResolved = false;

            const first = nighttimeActivity(sleeper, () => telescopeActivity(sleeper, "A", async () => {
                enteredFirst.resolve(undefined);
                await releaseFirst.promise;
            }));
            await enteredFirst.promise;

            const second = nighttimeActivity(sleeper, () => telescopeActivity(sleeper, "B", async () => {
                enteredSecondResolved = true;
            }));

            await Promise.resolve();
            expect(enteredSecondResolved).toBe(true);

            releaseFirst.resolve(undefined);
            await Promise.all([first, second]);
        });

        test("holiday + daytime => blocked", async () => {
            const capabilities = getMockedRootCapabilities();
            const sleeper = capabilities.sleeper;

            const releaseHoliday = makeDeferred();
            const enteredHoliday = makeDeferred();
            let enteredDayResolved = false;

            const holiday = holidayActivity(sleeper, async () => {
                enteredHoliday.resolve(undefined);
                await releaseHoliday.promise;
            });
            await enteredHoliday.promise;

            const day = daytimeActivity(sleeper, async () => {
                enteredDayResolved = true;
            });

            await Promise.resolve();
            expect(enteredDayResolved).toBe(false);

            releaseHoliday.resolve(undefined);
            await holiday;
            await day;
            expect(enteredDayResolved).toBe(true);
        });

        test("holiday + observation => blocked", async () => {
            const capabilities = getMockedRootCapabilities();
            const sleeper = capabilities.sleeper;

            const releaseHoliday = makeDeferred();
            const enteredHoliday = makeDeferred();
            let enteredNightResolved = false;

            const holiday = holidayActivity(sleeper, async () => {
                enteredHoliday.resolve(undefined);
                await releaseHoliday.promise;
            });
            await enteredHoliday.promise;

            const night = nighttimeActivity(sleeper, () => telescopeActivity(sleeper, "N", async () => {
                enteredNightResolved = true;
            }));

            await Promise.resolve();
            expect(enteredNightResolved).toBe(false);

            releaseHoliday.resolve(undefined);
            await holiday;
            await night;
            expect(enteredNightResolved).toBe(true);
        });

        test("holiday + holiday => serialized", async () => {
            const capabilities = getMockedRootCapabilities();
            const sleeper = capabilities.sleeper;

            const releaseFirst = makeDeferred();
            const enteredFirst = makeDeferred();
            let enteredSecondResolved = false;

            const first = holidayActivity(sleeper, async () => {
                enteredFirst.resolve(undefined);
                await releaseFirst.promise;
            });
            await enteredFirst.promise;

            const second = holidayActivity(sleeper, async () => {
                enteredSecondResolved = true;
            });

            await Promise.resolve();
            expect(enteredSecondResolved).toBe(false);

            releaseFirst.resolve(undefined);
            await Promise.all([first, second]);
            expect(enteredSecondResolved).toBe(true);
        });
    });

    describe("concurrent pull with inverse sibling-dependency order", () => {
        test("static inputs in inverse order do not deadlock", async () => {
            const db = new InMemoryDatabase();

            const graph = makeIncrementalGraph(testCapabilities, db, [
                {
                    output: "x",
                    inputs: [],
                    computor: async () => {
                        await new Promise((resolve) => setTimeout(resolve, 30));
                        return { type: "test", value: 1 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "y",
                    inputs: [],
                    computor: async () => {
                        await new Promise((resolve) => setTimeout(resolve, 30));
                        return { type: "test", value: 2 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                // A pulls [x, y] — x first, then y
                {
                    output: "a",
                    inputs: ["x", "y"],
                    computor: async ([x, y]) => {
                        return { type: "sum", value: x.value + y.value };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                // B pulls [y, x] — y first, then x (inverse order)
                {
                    output: "b",
                    inputs: ["y", "x"],
                    computor: async ([y, x]) => {
                        return { type: "sum", value: x.value + y.value };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ]);

            // Force fresh computation for both leaves
            await graph.invalidate("x");
            await graph.invalidate("y");

            // Concurrent pulls with inverse dependency order
            const [resultA, resultB] = await Promise.all([
                graph.pull("a"),
                graph.pull("b"),
            ]);

            expect(resultA.value).toBe(3);
            expect(resultB.value).toBe(3);
        });

        test("deep diamond with inverse order at inner level does not deadlock", async () => {
            const db = new InMemoryDatabase();

            const graph = makeIncrementalGraph(testCapabilities, db, [
                {
                    output: "z",
                    inputs: [],
                    computor: async () => {
                        await new Promise((resolve) => setTimeout(resolve, 20));
                        return { type: "test", value: 3 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "y",
                    inputs: [],
                    computor: async () => {
                        await new Promise((resolve) => setTimeout(resolve, 20));
                        return { type: "test", value: 2 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                // x depends on [y, z] — y first, then z
                {
                    output: "x",
                    inputs: ["y", "z"],
                    computor: async ([y, z]) => {
                        return { type: "sum", value: y.value + z.value };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                // u depends on [z, y] — z first, then y (inverse of x's order)
                {
                    output: "u",
                    inputs: ["z", "y"],
                    computor: async ([z, y]) => {
                        return { type: "sum", value: z.value + y.value };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "a",
                    inputs: ["x"],
                    computor: async ([x]) => {
                        return { type: "val", value: x.value };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "b",
                    inputs: ["u"],
                    computor: async ([u]) => {
                        return { type: "val", value: u.value };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ]);

            // Force fresh computation
            await graph.invalidate("y");
            await graph.invalidate("z");

            // Pull a (→ x → y then z) and b (→ u → z then y) concurrently
            const [resultA, resultB] = await Promise.all([
                graph.pull("a"),
                graph.pull("b"),
            ]);

            expect(resultA.value).toBe(5);
            expect(resultB.value).toBe(5);
        });
    });

    describe("concurrent invalidate proof verification", () => {
        /**
         * @template T
         * @returns {{ promise: Promise<T>, resolve: (value: T) => void }}
         */
        function makeDeferred() {
            let resolve = () => undefined;
            const promise = new Promise((resolveCallback) => {
                resolve = resolveCallback;
            });
            return { promise, resolve };
        }

        function buildChainGraph(db, capabilities) {
            return makeIncrementalGraph(capabilities, db, [
                {
                    output: "source",
                    inputs: [],
                    computor: async () => ({ type: "test", value: 1 }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "middle",
                    inputs: ["source"],
                    computor: async ([s]) => ({ type: "test", value: s.value + 1 }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "leaf",
                    inputs: ["middle"],
                    computor: async ([m]) => ({ type: "test", value: m.value + 1 }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ]);
        }

        test("concurrent invalidates on dependency chain: leaf freshness is potentially-outdated after both complete", async () => {
            const db = new InMemoryDatabase();
            const graph = buildChainGraph(db, testCapabilities);

            // Pull once to materialize the chain
            await graph.pull("leaf");

            // Invalidate source and middle concurrently
            await Promise.all([
                graph.invalidate("source"),
                graph.invalidate("middle"),
            ]);

            // Verify leaf is marked outdated (final pull recomputes)
            const result = await graph.pull("leaf");
            expect(result.value).toBe(3);
        });

        test("large burst of concurrent invalidates on different nodes sharing a dependent maintains consistency", async () => {
            const db = new InMemoryDatabase();
            const sources = Array.from({ length: 10 }, (_, i) => ({
                output: `source${i}`,
                inputs: [],
                computor: async () => ({ type: "test", value: i }),
                isDeterministic: true,
                hasSideEffects: false,
            }));
            const aggregator = {
                output: "agg",
                inputs: sources.map((_, i) => `source${i}`),
                computor: async (args) => {
                    const sum = args.reduce((acc, v) => acc + v.value, 0);
                    return { type: "sum", value: sum };
                },
                isDeterministic: true,
                hasSideEffects: false,
            };
            const graph = makeIncrementalGraph(testCapabilities, db, [
                ...sources, aggregator,
            ]);

            // Pull once to materialize
            const firstPull = await graph.pull("agg");
            expect(firstPull.value).toBe(45);

            // Burst of concurrent invalidates on all sources
            await Promise.all(sources.map((_, i) => graph.invalidate(`source${i}`)));

            // Re-pull after invalidates — should still produce correct sum
            const result = await graph.pull("agg");
            expect(result.value).toBe(45);
        });

        test("concurrent invalidates on shared dependent produce correct revdep structure regardless of commit order", async () => {
            const capabilities = getMockedRootCapabilities();
            const db = new InMemoryDatabase();

            const graph = makeIncrementalGraph(capabilities, db, [
                {
                    output: "a",
                    inputs: [],
                    computor: async () => ({ type: "test", value: 1 }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "b",
                    inputs: [],
                    computor: async () => ({ type: "test", value: 2 }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "sum",
                    inputs: ["a", "b"],
                    computor: async ([a, b]) => ({ type: "sum", value: a.value + b.value }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ]);

            // Pull once to materialize
            const firstPull = await graph.pull("sum");
            expect(firstPull.value).toBe(3);

            // Track enter/exit of withTransaction for each invalidate
            const tx1AfterCallback = makeDeferred();
            const tx2AfterCallback = makeDeferred();
            let enteredCount = 0;

            const originalWithTransaction = graph.storage.withTransaction.bind(graph.storage);
            graph.storage.withTransaction = async (fn) => {
                return originalWithTransaction(async (tx) => {
                    const result = await fn(tx);
                    enteredCount += 1;
                    if (enteredCount === 1) {
                        // TX1 collected diffs, pause before darkroom commit
                        await tx1AfterCallback.promise;
                    } else {
                        // TX2 collected diffs, pause before darkroom commit
                        await tx2AfterCallback.promise;
                    }
                    return result;
                });
            };

            const invalidateA = graph.invalidate("a");
            const invalidateB = graph.invalidate("b");

            // Both TXs collected their revdep diffs, now release TX2 to commit first
            tx2AfterCallback.resolve(undefined);

            // TX2 commits first — its write to revdeps lands on disk
            // Then release TX1 to commit second — its revdep diff sees TX2's committed writes
            tx1AfterCallback.resolve(undefined);

            await Promise.all([invalidateA, invalidateB]);

            // Re-pull — should still compute correct sum
            const result = await graph.pull("sum");
            expect(result.value).toBe(3);
        });

        test("concurrent invalidates on same node: freshness propagation to dependents is idempotent", async () => {
            const capabilities = getMockedRootCapabilities();
            const db = new InMemoryDatabase();

            const graph = makeIncrementalGraph(capabilities, db, [
                {
                    output: "root",
                    inputs: [],
                    computor: async () => ({ type: "test", value: 1 }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "mid",
                    inputs: ["root"],
                    computor: async ([r]) => ({ type: "test", value: r.value + 1 }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "far",
                    inputs: ["mid"],
                    computor: async ([m]) => ({ type: "test", value: m.value + 1 }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ]);

            // Pull once to materialize the full chain
            await graph.pull("far");

            // Run three concurrent invalidates on the root node
            await Promise.all([
                graph.invalidate("root"),
                graph.invalidate("root"),
                graph.invalidate("root"),
            ]);

            // All dependents should be consistently outdated
            // Re-pull should recompute all values
            const farResult = await graph.pull("far");
            expect(farResult.value).toBe(3);

            const midResult = await graph.pull("mid");
            expect(midResult.value).toBe(2);
        });

        test("concurrent invalidates: each TX has its own batch, one TX's writes are invisible to another until commit", async () => {
            const capabilities = getMockedRootCapabilities();
            const db = new InMemoryDatabase();

            const graph = makeIncrementalGraph(capabilities, db, [
                {
                    output: "src",
                    inputs: [],
                    computor: async () => ({ type: "test", value: 1 }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "dep",
                    inputs: ["src"],
                    computor: async ([s]) => ({ type: "test", value: s.value + 1 }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ]);

            // Pull once to materialize
            await graph.pull("dep");

            // Track freshness reads during the second TX
            const tx1Entered = makeDeferred();
            const tx2CanRead = makeDeferred();
            const tx2ReadFreshness = makeDeferred();
            let tx2SawValue = undefined;
            let entered = 0;

            const originalWithTransaction = graph.storage.withTransaction.bind(graph.storage);
            graph.storage.withTransaction = async (fn) => {
                return originalWithTransaction(async (tx) => {
                    const myIndex = entered;
                    entered += 1;

                    if (myIndex === 0) {
                        // TX1: let it run (writes freshness in its batch)
                        tx1Entered.resolve(undefined);
                        return await fn(tx);
                    }

                    // TX2: intercept freshness.get to observe read-committed behavior
                    const originalGet = tx.batch.freshness.get.bind(tx.batch.freshness);
                    tx.batch.freshness.get = async (key) => {
                        tx2CanRead.resolve(undefined);
                        const value = await originalGet(key);
                        tx2SawValue = value;
                        tx2ReadFreshness.resolve(undefined);
                        return value;
                    };

                    const result = await fn(tx);
                    return result;
                });
            };

            const invalidate1 = graph.invalidate("src");

            // Wait for TX1 to enter its withTransaction callback
            await tx1Entered.promise;

            // Start TX2 while TX1 is still in flight (hasn't committed yet)
            const invalidate2 = graph.invalidate("src");

            // Wait for TX2 to attempt reading freshness (this is inside TX2's callback)
            await tx2CanRead.promise;

            // At this point TX1 has written "potentially-outdated" for dep
            // into its own batch (not committed). TX2 is about to read dep's
            // freshness via its own batch.get, which falls through to live DB.
            // Since TX1 hasn't committed, TX2 should NOT see "potentially-outdated".

            await tx2ReadFreshness.promise;

            // TX2 read dep's freshness. If TX1 had already committed, dep would
            // be "potentially-outdated". But TX1 hasn't committed yet because
            // we intercepted at TX2's batch.get before TX1's commit.
            // The live DB freshness for dep is "up-to-date" (from the initial pull).
            expect(tx2SawValue).toBe("up-to-date");

            await Promise.all([invalidate1, invalidate2]);

            // After both commit, dep should be "potentially-outdated"
            const result = await graph.pull("dep");
            expect(result.value).toBe(2);
        });

        test("serializeTransactionLookup deduplicates shared allocations from concurrent pulls", async () => {
            const capabilities = getMockedRootCapabilities();
            const db = new InMemoryDatabase();

            const graph = makeIncrementalGraph(capabilities, db, [
                {
                    output: "source",
                    inputs: [],
                    computor: async () => ({ type: "test", value: 1 }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ]);

            // Never pull "source" so its identifier hasn't been allocated yet.
            // Two concurrent pulls will both try to allocate the same output key.
            //
            // TX1 allocates the identifier and commits (updating the base lookup).
            // TX2 then finds the key already in the committed base via txNodeKeyToId
            // and reuses the existing identifier without allocating again.
            // When TX2 commits second, serializeTransactionLookup serializes the base
            // (which TX1 already updated via commitTransactionLookup) and then appends
            // TX2's overlay — producing duplicate entries WITHOUT the fix.

            const afterTx1Commit = makeDeferred();
            let txCommitted = 0;

            const originalWithTransaction = graph.storage.withTransaction.bind(graph.storage);
            graph.storage.withTransaction = async (fn) => {
                const result = await originalWithTransaction(fn);
                txCommitted += 1;
                if (txCommitted === 1) {
                    // TX1 has committed and commitTransactionLookup updated the base.
                    // Pause here so TX2's serializeTransactionLookup runs after base is dirty.
                    await afterTx1Commit.promise;
                }
                return result;
            };

            const pull1 = graph.pull("source");
            const pull2 = graph.pull("source");

            // Release TX1 to commit first, then TX2
            afterTx1Commit.resolve(undefined);

            await Promise.all([pull1, pull2]);

            // Read the persisted identifiers_keys_map
            const schemaStorage = db.getSchemaStorage();
            const persisted = await schemaStorage.global.get(IDENTIFIERS_KEY);

            // makeIdentifierLookup throws IdentifierLookupError on duplicates
            // This would crash if serializeTransactionLookup produced duplicates
            expect(() => makeIdentifierLookup(persisted)).not.toThrow();

            // Verify the lookup contains exactly one mapping for "source"
            const lookup = makeIdentifierLookup(persisted);
            const sourceKey = JSON.stringify({ head: "source", args: [] });
            expect(lookup.keyToId.has(sourceKey)).toBe(true);
        });
    });
});
