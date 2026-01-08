/**
 * Tests for DependencyGraph concurrency safety.
 * These tests verify that the graph handles concurrent operations correctly
 * and prevents race conditions between set() and pull() operations.
 */

const {
    makeDependencyGraph,
} = require("../src/generators/dependency_graph");

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
class InMemoryDatabase {
    constructor() {
        /** @type {Map<string, Map<string, any>>} */
        this.schemas = new Map();
        /** @type {boolean} */
        this.closed = false;
    }

    getSchemaStorage(schemaHash) {
        if (!this.schemas.has(schemaHash)) {
            this.schemas.set(schemaHash, new Map());
        }
        const schemaMap = this.schemas.get(schemaHash);

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

        return {
            values,
            freshness,
            inputs,
            revdeps,
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

describe("DependencyGraph concurrency", () => {
    describe("concurrent set() operations", () => {
        test("multiple set() calls on same node are serialized", async () => {
            const db = new InMemoryDatabase();
            const graph = makeDependencyGraph(db, [
                {
                    output: "source",
                    inputs: [],
                    computor: async () => {
                        throw new Error("Should not be called");
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ]);

            // Track the order of operations
            const operationLog = [];

            // Create multiple concurrent set operations
            const promises = [];
            for (let i = 0; i < 10; i++) {
                const value = { type: "test", value: i };
                promises.push(
                    graph.set("source", value).then(() => {
                        operationLog.push(i);
                    })
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

        test("concurrent set() on different nodes works correctly", async () => {
            const db = new InMemoryDatabase();
            const graph = makeDependencyGraph(db, [
                {
                    output: "source1",
                    inputs: [],
                    computor: async () => {
                        throw new Error("Should not be called");
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "source2",
                    inputs: [],
                    computor: async () => {
                        throw new Error("Should not be called");
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ]);

            // Set different nodes concurrently
            await Promise.all([
                graph.set("source1", { type: "test", value: 1 }),
                graph.set("source2", { type: "test", value: 2 }),
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

            const graph = makeDependencyGraph(db, [
                {
                    output: "source",
                    inputs: [],
                    computor: async () => {
                        throw new Error("Should not be called");
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

            // Set source value
            await graph.set("source", { type: "test", value: 5 });

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

            // Computor should only be called once because of mutex serialization
            // and caching after first computation
            expect(computeCount).toBe(1);
        });

        test("concurrent pull() on different nodes works correctly", async () => {
            const db = new InMemoryDatabase();

            const graph = makeDependencyGraph(db, [
                {
                    output: "source1",
                    inputs: [],
                    computor: async () => {
                        throw new Error("Should not be called");
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "source2",
                    inputs: [],
                    computor: async () => {
                        throw new Error("Should not be called");
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ]);

            // Set source values
            await graph.set("source1", { type: "test", value: 1 });
            await graph.set("source2", { type: "test", value: 2 });

            // Pull different nodes concurrently
            const [result1, result2] = await Promise.all([
                graph.pull("source1"),
                graph.pull("source2"),
            ]);

            expect(result1.value).toBe(1);
            expect(result2.value).toBe(2);
        });
    });

    describe("concurrent set() and pull() operations", () => {
        test("concurrent set() and pull() on same node are serialized", async () => {
            const db = new InMemoryDatabase();

            const graph = makeDependencyGraph(db, [
                {
                    output: "source",
                    inputs: [],
                    computor: async () => {
                        throw new Error("Should not be called");
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ]);

            // Initial value
            await graph.set("source", { type: "test", value: 0 });

            // Concurrent set and pull operations
            const operations = [];
            for (let i = 0; i < 5; i++) {
                operations.push(
                    graph.set("source", { type: "test", value: i })
                );
                operations.push(graph.pull("source"));
            }

            const results = await Promise.all(operations);

            // Filter out undefined (from set operations)
            const pullResults = results.filter((r) => r !== undefined);

            // All pull results should be valid
            expect(pullResults.length).toBeGreaterThan(0);
            for (const result of pullResults) {
                expect(result.type).toBe("test");
                expect(result.value).toBeGreaterThanOrEqual(0);
                expect(result.value).toBeLessThan(5);
            }
        });

        test("set() on source invalidates dependent nodes correctly with concurrent pulls", async () => {
            const db = new InMemoryDatabase();
            let computeCount = 0;

            const graph = makeDependencyGraph(db, [
                {
                    output: "source",
                    inputs: [],
                    computor: async () => {
                        throw new Error("Should not be called");
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
            await graph.set("source", { type: "test", value: 5 });

            // Pull derived to compute it
            const result1 = await graph.pull("derived");
            expect(result1.value).toBe(10);
            expect(computeCount).toBe(1);

            // Reset compute count
            computeCount = 0;

            // Concurrent operations: update source and pull derived
            await Promise.all([
                graph.set("source", { type: "test", value: 10 }),
                graph.pull("derived"),
                graph.pull("derived"),
            ]);

            // Pull again to ensure we get the updated value
            const result2 = await graph.pull("derived");
            expect(result2.value).toBe(20);

            // Computor should have been called at least once for the new value
            expect(computeCount).toBeGreaterThanOrEqual(1);
        });

        test("concurrent set-pull cycles maintain consistency", async () => {
            const db = new InMemoryDatabase();

            const graph = makeDependencyGraph(db, [
                {
                    output: "counter",
                    inputs: [],
                    computor: async () => {
                        throw new Error("Should not be called");
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
            await graph.set("counter", { type: "test", value: 0 });

            // Simulate concurrent async operations doing increment + read cycles
            const cycles = [];
            for (let i = 1; i <= 5; i++) {
                cycles.push(
                    (async () => {
                        await graph.set("counter", { type: "test", value: i });
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

            const graph = makeDependencyGraph(db, [
                {
                    output: "a",
                    inputs: [],
                    computor: async () => {
                        throw new Error("Should not be called");
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "b",
                    inputs: [],
                    computor: async () => {
                        throw new Error("Should not be called");
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
            await graph.set("a", { type: "test", value: 1 });
            await graph.set("b", { type: "test", value: 2 });

            // Concurrent operations
            await Promise.all([
                graph.pull("c"),
                graph.pull("d"),
                graph.set("a", { type: "test", value: 5 }),
                graph.pull("c"),
                graph.set("b", { type: "test", value: 10 }),
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
});
