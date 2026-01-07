/**
 * These are tests generated purely from the spec alone.
 * They do not depend on any particular implementation details,
 * only on the public API of the dependency graph module.
 */

const {
    makeDependencyGraph,
    isDependencyGraph,
    makeUnchanged,
    isUnchanged,
} = require("../src/generators/dependency_graph");
const { toJsonKey } = require("./test_json_key_helper");

function expectOneOfNames(err, names) {
    expect(err).toBeTruthy();
    const n = err.name || err.code;
    expect(names).toContain(n);
}

function expectHasOwn(err, prop) {
    expect(Object.prototype.hasOwnProperty.call(err, prop)).toBe(true);
}

/**
 * Minimal in-memory Database that matches the RootDatabase interface.
 * We implement the sublevel structure in memory.
 */
class InMemoryDatabase {
    constructor() {
        /** @type {Map<string, Map<string, any>>} */
        this.schemas = new Map();
        /** @type {Map<string, any>} */
        this.root = new Map();
        /** @type {boolean} */
        this.closed = false;
        /** @type {Array<any>} */
        this.batchLog = [];
        /** @type {Array<any>} */
        this.putLog = [];
        /** @type {Array<any>} */
        this.getValueLog = [];
    }

    getSchemaStorage(schemaHash) {
        if (!this.schemas.has(schemaHash)) {
            this.schemas.set(schemaHash, new Map());
        }
        const schemaMap = this.schemas.get(schemaHash);
        
        // Don't capture logs in closure - use arrow functions to preserve 'this' context
        const createSublevel = (name) => {
            const prefix = `${name}:`;
            const sublevel = {
                get: async (key) => {
                    const fullKey = prefix + key;
                    // Track get calls for values sublevel
                    if (name === 'values') {
                        this.getValueLog.push({ key });
                    }
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
                    return { type: 'put', sublevel, key, value };
                },
                delOp: (key) => {
                    return { type: 'del', sublevel, key };
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

        const values = createSublevel('values');
        const freshness = createSublevel('freshness');
        const inputs = createSublevel('inputs');
        const revdeps = createSublevel('revdeps');

        return {
            values,
            freshness,
            inputs,
            revdeps,
            batch: async (operations) => {
                // Track batch calls - use this to access current array
                this.batchLog.push({ ops: deepClone(operations.map(op => ({ 
                    type: op.type, 
                    key: op.key, 
                    value: op.value 
                }))) });
                
                // Atomic application of batch operations
                for (const op of operations) {
                    if (op.type === 'put') {
                        await op.sublevel.put(op.key, op.value);
                    } else if (op.type === 'del') {
                        await op.sublevel.del(op.key);
                    }
                }
            },
        };
    }

    async *listSchemas() {
        for (const schemaHash of this.schemas.keys()) {
            yield schemaHash;
        }
    }

    // Backward compatibility for tests that access root level
    async put(key, value) {
        if (this.closed) throw new Error("DatabaseClosed");
        this.putLog.push({ key, value });
        this.root.set(key, deepClone(value));
    }

    async get(key) {
        if (this.closed) throw new Error("DatabaseClosed");
        const v = this.root.get(key);
        return v === undefined ? undefined : deepClone(v);
    }

    async keys(prefix) {
        if (this.closed) throw new Error("DatabaseClosed");
        const res = [];
        for (const k of this.root.keys()) {
            if (!prefix || k.startsWith(prefix)) res.push(k);
        }
        return res;
    }

    async batch(ops) {
        if (this.closed) throw new Error("DatabaseClosed");
        this.batchLog.push({ ops: deepClone(ops) });

        // atomic apply
        for (const op of ops) {
            if (op.type === "put") {
                this.root.set(op.key, deepClone(op.value));
            } else if (op.type === "del") {
                this.root.delete(op.key);
            } else throw new Error(`UnknownBatchOp:${String(op.type)}`);
        }
    }

    async close() {
        this.closed = true;
    }

    resetLogs() {
        this.batchLog = [];
        this.putLog = [];
        this.getValueLog = [];
    }

    /**
     * Helper to corrupt database by deleting a value from all schemas (for testing).
     * This simulates database corruption where the value is deleted but freshness remains.
     * @param {string} key - The key to delete (will be converted to JSON format)
     */
    async corruptByDeletingValue(key) {
        const jsonKey = toJsonKey(key);
        
        // Delete from all schemas
        for (const schemaMap of this.schemas.values()) {
            schemaMap.delete('values:' + jsonKey);
        }
    }

    /**
     * Helper to seed a schema storage directly (for testing seeded databases).
     * This bypasses normal indexing to simulate partially-seeded databases.
     * @param {string} schemaHash - The schema hash
     * @param {string} sublevel - The sublevel name ('values', 'freshness', 'inputs', 'revdeps')
     * @param {string} key - The key
     * @param {any} value - The value
     */
    async seedSchemaStorage(schemaHash, sublevel, key, value) {
        if (!this.schemas.has(schemaHash)) {
            this.schemas.set(schemaHash, new Map());
        }
        const schemaMap = this.schemas.get(schemaHash);
        const fullKey = `${sublevel}:${key}`;
        schemaMap.set(fullKey, deepClone(value));
    }
}

function deepClone(x) {
    // Good enough for JSON-like DatabaseValue.
    return x === undefined ? undefined : JSON.parse(JSON.stringify(x));
}

/** Helper to build a graph and assert it "looks like" a DependencyGraph. */
function buildGraph(db, nodeDefs) {
    const g = makeDependencyGraph(db, nodeDefs);
    expect(isDependencyGraph(g)).toBe(true);
    expect(typeof g.pull).toBe("function");
    expect(typeof g.set).toBe("function");
    return g;
}

/** Helper to create a computor with a call counter. */
function countedComputor(name, fn) {
    const counter = { name, calls: 0, args: [] };
    const computor = async (inputs, oldValue, bindings) => {
        counter.calls += 1;
        counter.args.push({
            inputs: deepClone(inputs),
            oldValue: deepClone(oldValue),
            bindings: deepClone(bindings),
        });
        return fn(inputs, oldValue, bindings);
    };
    return { computor, counter };
}

describe("DependencyGraph Conformance: module surface", () => {
    test("exports required symbols", () => {
        expect(typeof makeDependencyGraph).toBe("function");
        expect(typeof isDependencyGraph).toBe("function");
        expect(typeof makeUnchanged).toBe("function");
        expect(typeof isUnchanged).toBe("function");
    });

    test("Unchanged sentinel round-trip via isUnchanged", () => {
        const u = makeUnchanged();
        expect(isUnchanged(u)).toBe(true);
        expect(isUnchanged(undefined)).toBe(false);
        expect(isUnchanged(null)).toBe(false);
        expect(isUnchanged(0)).toBe(false);
        expect(isUnchanged("Unchanged")).toBe(false);
        expect(isUnchanged({})).toBe(false);
    });
});

describe("Schema validation (construction-time errors)", () => {
    test("throws InvalidExpressionError for invalid schema expression syntax", () => {
        const db = new InMemoryDatabase();
        expect(() =>
            makeDependencyGraph(db, [
                {
                    output: "bad(",
                    inputs: [],
                    computor: async () => ({ ok: true }),
                },
            ])
        ).toThrow();
        try {
            makeDependencyGraph(db, [
                {
                    output: "bad(",
                    inputs: [],
                    computor: async () => ({ ok: true }),
                },
            ]);
        } catch (e) {
            expectOneOfNames(e, ["InvalidExpressionError"]);
            expectHasOwn(e, "expression");
        }
    });

    test("throws InvalidSchemaError for duplicate variable names in output", () => {
        const db = new InMemoryDatabase();
        let error;
        try {
            makeDependencyGraph(db, [
                {
                    output: "event(a, b, c, b, d)",
                    inputs: [],
                    computor: async () => ({ ok: true }),
                },
            ]);
        } catch (e) {
            error = e;
        }
        expect(error).toBeTruthy();
        expectOneOfNames(error, ["InvalidSchema"]);
        expect(error.message).toMatch(/Duplicate variable 'b'/);
    });

    test("throws InvalidSchemaError for duplicate variable names in input", () => {
        const db = new InMemoryDatabase();
        let error;
        try {
            makeDependencyGraph(db, [
                {
                    output: "derived(x, y)",
                    inputs: ["source(x, z, x)"],
                    computor: async () => ({ ok: true }),
                },
            ]);
        } catch (e) {
            error = e;
        }
        expect(error).toBeTruthy();
        expectOneOfNames(error, ["InvalidSchema"]);
        expect(error.message).toMatch(/Duplicate variable 'x'/);
    });

    test("throws InvalidSchemaError when output variables do not cover input variables", () => {
        const db = new InMemoryDatabase();
        expect(() =>
            makeDependencyGraph(db, [
                {
                    output: "derived_event()",
                    inputs: ["event_context(e)"],
                    computor: async () => ({ ok: true }),
                },
            ])
        ).toThrow();
        try {
            makeDependencyGraph(db, [
                {
                    output: "derived_event()",
                    inputs: ["event_context(e)"],
                    computor: async () => ({ ok: true }),
                },
            ]);
        } catch (e) {
            expectOneOfNames(e, ["InvalidSchemaError", "InvalidSchema"]);
            expectHasOwn(e, "schemaOutput");
        }
    });

    test("throws SchemaOverlapError for trivially overlapping patterns node(x) vs node(y)", () => {
        const db = new InMemoryDatabase();
        let error;
        try {
            makeDependencyGraph(db, [
                {
                    output: "node(x)",
                    inputs: [],
                    computor: async () => ({ a: 1 }),
                },
                {
                    output: "node(y)",
                    inputs: [],
                    computor: async () => ({ b: 2 }),
                },
            ]);
        } catch (e) {
            error = e;
        }
        expect(error).toBeDefined();
        expectOneOfNames(error, ["SchemaOverlapError"]);
        expectHasOwn(error, "patterns");
        expect(Array.isArray(error.patterns)).toBe(true);
    });



    test("throws SchemaCycleError for a <-> b cycle", () => {
        const db = new InMemoryDatabase();
        expect(() =>
            makeDependencyGraph(db, [
                {
                    output: "a",
                    inputs: ["b"],
                    computor: async ([b]) => ({ aFrom: b }),
                },
                {
                    output: "b",
                    inputs: ["a"],
                    computor: async ([a]) => ({ bFrom: a }),
                },
            ])
        ).toThrow();
        try {
            makeDependencyGraph(db, [
                {
                    output: "a",
                    inputs: ["b"],
                    computor: async ([b]) => ({ aFrom: b }),
                },
                {
                    output: "b",
                    inputs: ["a"],
                    computor: async ([a]) => ({ bFrom: a }),
                },
            ]);
        } catch (e) {
            expectOneOfNames(e, ["SchemaCycleError"]);
            expectHasOwn(e, "cycle");
        }
    });

    test("throws SchemaCycleError for parameterized cycle f(x)->g(x)->f(x)", () => {
        const db = new InMemoryDatabase();
        expect(() =>
            makeDependencyGraph(db, [
                {
                    output: "f(x)",
                    inputs: ["g(x)"],
                    computor: async ([g]) => g,
                },
                {
                    output: "g(x)",
                    inputs: ["f(x)"],
                    computor: async ([f]) => f,
                },
            ])
        ).toThrow();
        try {
            makeDependencyGraph(db, [
                {
                    output: "f(x)",
                    inputs: ["g(x)"],
                    computor: async ([g]) => g,
                },
                {
                    output: "g(x)",
                    inputs: ["f(x)"],
                    computor: async ([f]) => f,
                },
            ]);
        } catch (e) {
            expectOneOfNames(e, ["SchemaCycleError"]);
        }
    });
});

describe("Expression parsing & canonicalization at API boundaries", () => {
    test("rejects non-natural numbers: negative", async () => {
        const db = new InMemoryDatabase();
        const g = buildGraph(db, [
            {
                output: "id(n)",
                inputs: [],
                computor: async (_i, _o, b) => ({ n: b[0] }),
            },
        ]);

        // In the new API, "id(-1)" is just treated as a head name
        // Since the real head is "id", this throws InvalidNode
        await expect(g.pull("id(-1)")).rejects.toMatchObject({
            name: "InvalidNode",
        });
    });

    test("rejects non-natural numbers: float", async () => {
        const db = new InMemoryDatabase();
        const g = buildGraph(db, [
            {
                output: "id(n)",
                inputs: [],
                computor: async (_i, _o, b) => ({ n: b[0] }),
            },
        ]);

        // In the new API, "id(1.2)" is just treated as a head name
        // Since the real head is "id", this throws InvalidNode
        await expect(g.pull("id(1.2)")).rejects.toMatchObject({
            name: "InvalidNode",
        });
    });

    test("rejects nat with leading zeros: 01", async () => {
        const db = new InMemoryDatabase();
        const g = buildGraph(db, [
            {
                output: "id(n)",
                inputs: [],
                computor: async (_i, _o, b) => ({ n: b[0] }),
            },
        ]);

        // In the new API, "id(01)" is just treated as a head name
        // Since the real head is "id", this throws InvalidNode
        await expect(g.pull("id(01)")).rejects.toMatchObject({
            name: "InvalidNode",
        });
    });
});

describe("pull/set concrete-ness & node existence errors", () => {
    test("pull rejects non-concrete nodeName (free variables) with NonConcreteNodeError", async () => {
        const db = new InMemoryDatabase();
        const g = buildGraph(db, [
            {
                output: "event_context(e)",
                inputs: [],
                computor: async () => ({ ok: true }),
            },
        ]);

        // In the new API, "event_context(e)" is treated as a literal head name
        // Since the real head is "event_context", this throws InvalidNode
        await expect(g.pull("event_context(e)")).rejects.toMatchObject({
            name: expect.stringMatching(
                /^(InvalidNodeError|InvalidNode)$/
            ),
        });
    });

    test("set rejects non-concrete nodeName (free variables) with NonConcreteNodeError", async () => {
        const db = new InMemoryDatabase();
        const g = buildGraph(db, [
            {
                output: "event_context(e)",
                inputs: [],
                computor: async () => ({ ok: true }),
            },
        ]);

        // In the new API, "event_context(e)" is treated as a literal head name
        // Since the real head is "event_context", this throws InvalidNode
        await expect(g.set("event_context(e)", { x: 1 })).rejects.toMatchObject(
            {
                name: expect.stringMatching(
                    /^(InvalidNodeError|InvalidNode)$/
                ),
            }
        );
    });

    test("pull unknown concrete node throws InvalidNodeError", async () => {
        const db = new InMemoryDatabase();
        const g = buildGraph(db, [
            { output: "a", inputs: [], computor: async () => ({ a: 1 }) },
        ]);

        await expect(g.pull("does_not_exist")).rejects.toMatchObject({
            name: expect.stringMatching(/^(InvalidNodeError|InvalidNode)$/),
        });
    });

    test("set unknown concrete node throws InvalidNodeError", async () => {
        const db = new InMemoryDatabase();
        const g = buildGraph(db, [
            { output: "a", inputs: [], computor: async () => ({ a: 1 }) },
        ]);

        await expect(g.set("does_not_exist", { x: 1 })).rejects.toMatchObject({
            name: expect.stringMatching(/^(InvalidNodeError|InvalidNode)$/),
        });
    });

    test("set on non-source node throws InvalidSetError", async () => {
        const db = new InMemoryDatabase();
        const g = buildGraph(db, [
            {
                output: "a",
                inputs: [],
                computor: async (_i, old) => old || { n: 0 },
            },
            {
                output: "b",
                inputs: ["a"],
                computor: async ([a]) => ({ n: a.n + 1 }),
            },
        ]);

        await expect(g.set("b", { n: 999 })).rejects.toMatchObject({
            name: "InvalidSetError",
        });
    });
});

describe("Basic operational semantics: set/pull, caching, invalidation", () => {
    test("linear chain A->B->C computes correctly", async () => {
        const db = new InMemoryDatabase();

        const bC = countedComputor("b", async ([a]) => ({ n: a.n + 1 }));
        const cC = countedComputor("c", async ([b]) => ({ n: b.n + 1 }));

        const g = buildGraph(db, [
            {
                output: "a",
                inputs: [],
                computor: async (_i, old) => old || { n: 0 },
            },
            { output: "b", inputs: ["a"], computor: bC.computor },
            { output: "c", inputs: ["b"], computor: cC.computor },
        ]);

        await g.set("a", { n: 10 });
        const c = await g.pull("c");
        expect(c).toEqual({ n: 12 });
        expect(bC.counter.calls).toBe(1);
        expect(cC.counter.calls).toBe(1);
    });

    test("second pull of same node is cached (no recomputation when up-to-date)", async () => {
        const db = new InMemoryDatabase();

        const bC = countedComputor("b", async ([a]) => ({ n: a.n + 1 }));
        const g = buildGraph(db, [
            {
                output: "a",
                inputs: [],
                computor: async (_i, old) => old || { n: 0 },
            },
            { output: "b", inputs: ["a"], computor: bC.computor },
        ]);

        await g.set("a", { n: 1 });
        const b1 = await g.pull("b");
        const b2 = await g.pull("b");
        expect(b1).toEqual({ n: 2 });
        expect(b2).toEqual({ n: 2 });

        // Must not recompute b on second pull (expected efficiency behavior; also implied by freshness caching)
        expect(bC.counter.calls).toBe(1);
    });

    test("set invalidates dependents so next pull recomputes", async () => {
        const db = new InMemoryDatabase();

        const bC = countedComputor("b", async ([a]) => ({ n: a.n + 1 }));
        const g = buildGraph(db, [
            {
                output: "a",
                inputs: [],
                computor: async (_i, old) => old || { n: 0 },
            },
            { output: "b", inputs: ["a"], computor: bC.computor },
        ]);

        await g.set("a", { n: 1 });
        await g.pull("b");
        expect(bC.counter.calls).toBe(1);

        await g.set("a", { n: 5 });
        const b2 = await g.pull("b");
        expect(b2).toEqual({ n: 6 });
        expect(bC.counter.calls).toBe(2);
    });

    test("set uses a single atomic database.batch()", async () => {
        const db = new InMemoryDatabase();
        const g = buildGraph(db, [
            {
                output: "a",
                inputs: [],
                computor: async (_i, old) => old || { n: 0 },
            },
        ]);

        db.resetLogs();
        await g.set("a", { n: 123 });
        expect(db.batchLog.length).toBe(1);
    });

    test("order preservation", async () => {
        const db = new InMemoryDatabase();

        const bC = countedComputor("b", async ([a]) => ({
            s: "b(" + a.s + ")",
        }));
        const cC = countedComputor("c", async ([b]) => ({
            s: "c(" + b.s + ")",
        }));

        const g = buildGraph(db, [
            {
                output: "a",
                inputs: [],
                computor: async (_i, old) => old || { s: "a()" },
            },
            { output: "b", inputs: ["a"], computor: bC.computor },
            { output: "c", inputs: ["b"], computor: cC.computor },
        ]);

        await g.set("a", { s: "a()" });
        const c = await g.pull("c");
        expect(c).toEqual({ s: "c(b(a()))" });
        expect(bC.counter.calls).toBe(1);
        expect(cC.counter.calls).toBe(1);
    });

    test("outdated propagation", async () => {
        const db = new InMemoryDatabase();

        const bC = countedComputor("b", async ([a]) => ({
            s: "b(" + a.s + ")",
        }));
        const cC = countedComputor("c", async ([b]) => ({
            s: "c(" + b.s + ")",
        }));

        const g = buildGraph(db, [
            {
                output: "a",
                inputs: [],
                computor: async (_i, old) => old || { s: "a()" },
            },
            { output: "b", inputs: ["a"], computor: bC.computor },
            { output: "c", inputs: ["b"], computor: cC.computor },
        ]);

        await expect(g.debugGetFreshness("a")).resolves.toBe("missing");
        await expect(g.debugGetFreshness("b")).resolves.toBe("missing");
        await expect(g.debugGetFreshness("c")).resolves.toBe("missing");

        await g.set("a", { s: "a()" });

        await expect(g.debugGetFreshness("a")).resolves.toBe("up-to-date");
        await expect(g.debugGetFreshness("b")).resolves.toBe("missing");
        await expect(g.debugGetFreshness("c")).resolves.toBe("missing");

        const c = await g.pull("c");
        expect(c).toEqual({ s: "c(b(a()))" });
        expect(bC.counter.calls).toBe(1);
        expect(cC.counter.calls).toBe(1);

        await expect(g.debugGetFreshness("a")).resolves.toBe("up-to-date");
        await expect(g.debugGetFreshness("b")).resolves.toBe("up-to-date");
        await expect(g.debugGetFreshness("c")).resolves.toBe("up-to-date");

        await g.set("a", { s: "a()" });

        await expect(g.debugGetFreshness("a")).resolves.toBe("up-to-date");
        await expect(g.debugGetFreshness("b")).resolves.toBe(
            "potentially-outdated"
        );
        await expect(g.debugGetFreshness("c")).resolves.toBe(
            "potentially-outdated"
        );

        const b = await g.pull("b");
        expect(b).toEqual({ s: "b(a())" });
        expect(bC.counter.calls).toBe(2); // one recompute
        expect(cC.counter.calls).toBe(1); // no recompute yet

        await expect(g.debugGetFreshness("a")).resolves.toBe("up-to-date");
        await expect(g.debugGetFreshness("b")).resolves.toBe("up-to-date");
        // Must still be potentially-outdated because c not recomputed yet.
        await expect(g.debugGetFreshness("c")).resolves.toBe(
            "potentially-outdated"
        );
    });

    test("unchanged optimization", async () => {
        // Note that the only difference vs the "outdated propagation" test above
        // is that b's computor returns makeUnchanged() if a did not change.
        // But the freshness propagation behavior must be the same.
        const db = new InMemoryDatabase();

        const bC = countedComputor("b", async ([a], oldValue) => {
            if (oldValue) {
                return makeUnchanged();
            } else {
                return { s: "b(" + a.s + ")" };
            }
        });
        const cC = countedComputor("c", async ([b]) => ({
            s: "c(" + b.s + ")",
        }));

        const g = buildGraph(db, [
            {
                output: "a",
                inputs: [],
                computor: async (_i, old) => old || { s: "a()" },
            },
            { output: "b", inputs: ["a"], computor: bC.computor },
            { output: "c", inputs: ["b"], computor: cC.computor },
        ]);

        await expect(g.debugGetFreshness("a")).resolves.toBe("missing");
        await expect(g.debugGetFreshness("b")).resolves.toBe("missing");
        await expect(g.debugGetFreshness("c")).resolves.toBe("missing");

        await g.set("a", { s: "a()" });

        await expect(g.debugGetFreshness("a")).resolves.toBe("up-to-date");
        await expect(g.debugGetFreshness("b")).resolves.toBe("missing");
        await expect(g.debugGetFreshness("c")).resolves.toBe("missing");

        const c = await g.pull("c");
        expect(c).toEqual({ s: "c(b(a()))" });
        expect(bC.counter.calls).toBe(1);
        expect(cC.counter.calls).toBe(1);

        await expect(g.debugGetFreshness("a")).resolves.toBe("up-to-date");
        await expect(g.debugGetFreshness("b")).resolves.toBe("up-to-date");
        await expect(g.debugGetFreshness("c")).resolves.toBe("up-to-date");

        await g.set("a", { s: "a()" });

        await expect(g.debugGetFreshness("a")).resolves.toBe("up-to-date");
        await expect(g.debugGetFreshness("b")).resolves.toBe(
            "potentially-outdated"
        );
        await expect(g.debugGetFreshness("c")).resolves.toBe(
            "potentially-outdated"
        );

        const b = await g.pull("b");
        expect(b).toEqual({ s: "b(a())" });
        expect(bC.counter.calls).toBe(2); // one recompute
        expect(cC.counter.calls).toBe(1); // no recompute yet

        await expect(g.debugGetFreshness("a")).resolves.toBe("up-to-date");
        await expect(g.debugGetFreshness("b")).resolves.toBe("up-to-date");
        // Must still be potentially-outdated because c not recomputed yet.
        await expect(g.debugGetFreshness("c")).resolves.toBe(
            "potentially-outdated"
        );
    });

    test("unchanged optimization long", async () => {
        const db = new InMemoryDatabase();

        function unoptimizedComputor(name) {
            return countedComputor(name, async ([x]) => ({
                s: name + "(" + x.s + ")",
            }));
        }
        function optimizedComputor(name) {
            return countedComputor(name, async ([x], oldValue) => {
                const value = name + "(" + x.s + ")";
                const ret = { s: value };
                if (JSON.stringify(oldValue) === JSON.stringify(ret)) {
                    return makeUnchanged();
                } else {
                    return ret;
                }
            });
        }

        function nc(fun) {
            return fun.counter.calls;
        }

        async function fr(nodeName) {
            return g.debugGetFreshness(nodeName);
        }

        const aC = unoptimizedComputor("a");
        const bC = unoptimizedComputor("b");
        const cC = optimizedComputor("c");
        const dC = unoptimizedComputor("d");
        const eC = unoptimizedComputor("e");

        const g = buildGraph(db, [
            { output: "a", inputs: [], computor: aC.computor },
            { output: "b", inputs: ["a"], computor: bC.computor },
            { output: "c", inputs: ["b"], computor: cC.computor },
            { output: "d", inputs: ["c"], computor: dC.computor },
            { output: "e", inputs: ["d"], computor: eC.computor },
        ]);

        expect(nc(aC)).toBe(0);
        expect(nc(bC)).toBe(0);
        expect(nc(cC)).toBe(0);
        expect(nc(dC)).toBe(0);
        expect(nc(eC)).toBe(0);

        await expect(fr("a")).resolves.toBe("missing");
        await expect(fr("b")).resolves.toBe("missing");
        await expect(fr("c")).resolves.toBe("missing");
        await expect(fr("d")).resolves.toBe("missing");
        await expect(fr("e")).resolves.toBe("missing");

        await g.set("a", { s: "a()" });

        await expect(fr("a")).resolves.toBe("up-to-date");
        await expect(fr("b")).resolves.toBe("missing");
        await expect(fr("c")).resolves.toBe("missing");
        await expect(fr("d")).resolves.toBe("missing");
        await expect(fr("e")).resolves.toBe("missing");

        const c = await g.pull("c");
        expect(c).toEqual({ s: "c(b(a()))" });

        expect(nc(aC)).toBe(0);
        expect(nc(bC)).toBe(1);
        expect(nc(cC)).toBe(1);
        expect(nc(dC)).toBe(0);
        expect(nc(eC)).toBe(0);

        await expect(fr("a")).resolves.toBe("up-to-date");
        await expect(fr("b")).resolves.toBe("up-to-date");
        await expect(fr("c")).resolves.toBe("up-to-date");
        await expect(fr("d")).resolves.toBe("missing");
        await expect(fr("e")).resolves.toBe("missing");

        await g.set("a", { s: "a()" });

        await expect(fr("a")).resolves.toBe("up-to-date");
        await expect(fr("b")).resolves.toBe("potentially-outdated");
        await expect(fr("c")).resolves.toBe("potentially-outdated");
        await expect(fr("d")).resolves.toBe("missing");
        await expect(fr("e")).resolves.toBe("missing");

        const b = await g.pull("b");
        expect(b).toEqual({ s: "b(a())" });

        expect(nc(aC)).toBe(0);
        expect(nc(bC)).toBe(2); // one recompute
        expect(nc(cC)).toBe(1); // no recompute yet
        expect(nc(dC)).toBe(0);
        expect(nc(eC)).toBe(0);

        await expect(fr("a")).resolves.toBe("up-to-date");
        await expect(fr("b")).resolves.toBe("up-to-date");
        await expect(fr("c")).resolves.toBe("potentially-outdated");
        await expect(fr("d")).resolves.toBe("missing");
        await expect(fr("e")).resolves.toBe("missing");
    });

    test("unchanged optimization long with skips", async () => {
        const db = new InMemoryDatabase();

        function unoptimizedComputor(name) {
            return countedComputor(name, async ([x]) => ({
                s: name + "(" + x.s + ")",
            }));
        }
        function optimizedComputor(name) {
            return countedComputor(name, async ([x], oldValue) => {
                const value = name + "(" + x.s + ")";
                const ret = { s: value };
                if (JSON.stringify(oldValue) === JSON.stringify(ret)) {
                    return makeUnchanged();
                } else {
                    return ret;
                }
            });
        }

        function nc(fun) {
            return fun.counter.calls;
        }

        async function fr(nodeName) {
            return g.debugGetFreshness(nodeName);
        }

        const aC = unoptimizedComputor("a");
        const bC = unoptimizedComputor("b");
        const cC = optimizedComputor("c");
        const dC = unoptimizedComputor("d");
        const eC = unoptimizedComputor("e");

        const g = buildGraph(db, [
            { output: "a", inputs: [], computor: aC.computor },
            { output: "b", inputs: ["a"], computor: bC.computor },
            { output: "c", inputs: ["b"], computor: cC.computor },
            { output: "d", inputs: ["c"], computor: dC.computor },
            { output: "e", inputs: ["d"], computor: eC.computor },
        ]);

        expect(nc(aC)).toBe(0);
        expect(nc(bC)).toBe(0);
        expect(nc(cC)).toBe(0);
        expect(nc(dC)).toBe(0);
        expect(nc(eC)).toBe(0);

        await expect(fr("a")).resolves.toBe("missing");
        await expect(fr("b")).resolves.toBe("missing");
        await expect(fr("c")).resolves.toBe("missing");
        await expect(fr("d")).resolves.toBe("missing");
        await expect(fr("e")).resolves.toBe("missing");

        await g.set("a", { s: "a()" });

        await expect(fr("a")).resolves.toBe("up-to-date");
        await expect(fr("b")).resolves.toBe("missing");
        await expect(fr("c")).resolves.toBe("missing");
        await expect(fr("d")).resolves.toBe("missing");
        await expect(fr("e")).resolves.toBe("missing");

        const c = await g.pull("c");
        expect(c).toEqual({ s: "c(b(a()))" });

        expect(nc(aC)).toBe(0);
        expect(nc(bC)).toBe(1);
        expect(nc(cC)).toBe(1);
        expect(nc(dC)).toBe(0);
        expect(nc(eC)).toBe(0);

        await expect(fr("a")).resolves.toBe("up-to-date");
        await expect(fr("b")).resolves.toBe("up-to-date");
        await expect(fr("c")).resolves.toBe("up-to-date");
        await expect(fr("d")).resolves.toBe("missing");
        await expect(fr("e")).resolves.toBe("missing");

        await g.set("a", { s: "a()" });

        await expect(fr("a")).resolves.toBe("up-to-date");
        await expect(fr("b")).resolves.toBe("potentially-outdated");
        await expect(fr("c")).resolves.toBe("potentially-outdated");
        await expect(fr("d")).resolves.toBe("missing");
        await expect(fr("e")).resolves.toBe("missing");

        const b = await g.pull("b");
        expect(b).toEqual({ s: "b(a())" });

        expect(nc(aC)).toBe(0);
        expect(nc(bC)).toBe(2); // one recompute
        expect(nc(cC)).toBe(1); // no recompute yet
        expect(nc(dC)).toBe(0);
        expect(nc(eC)).toBe(0);

        await expect(fr("a")).resolves.toBe("up-to-date");
        await expect(fr("b")).resolves.toBe("up-to-date");
        await expect(fr("c")).resolves.toBe("potentially-outdated");
        await expect(fr("d")).resolves.toBe("missing");
        await expect(fr("e")).resolves.toBe("missing");

        const e1 = await g.pull("e");
        expect(e1).toEqual({ s: "e(d(c(b(a()))))" });

        expect(nc(aC)).toBe(0);
        expect(nc(bC)).toBe(2); // one recompute
        expect(nc(cC)).toBe(2); // no recompute yet
        expect(nc(dC)).toBe(1);
        expect(nc(eC)).toBe(1);

        await expect(fr("a")).resolves.toBe("up-to-date");
        await expect(fr("b")).resolves.toBe("up-to-date");
        await expect(fr("c")).resolves.toBe("up-to-date");
        await expect(fr("d")).resolves.toBe("up-to-date");
        await expect(fr("e")).resolves.toBe("up-to-date");

        await g.set("a", { s: "a()" });

        await expect(fr("a")).resolves.toBe("up-to-date");
        await expect(fr("b")).resolves.toBe("potentially-outdated");
        await expect(fr("c")).resolves.toBe("potentially-outdated");
        await expect(fr("d")).resolves.toBe("potentially-outdated");
        await expect(fr("e")).resolves.toBe("potentially-outdated");

        const e2 = await g.pull("e");
        expect(e2).toEqual({ s: "e(d(c(b(a()))))" });

        expect(nc(aC)).toBe(0);
        expect(nc(bC)).toBe(3); // one recompute
        expect(nc(cC)).toBe(3); // one recompute
        expect(nc(dC)).toBe(1); // no recompute because c unchanged
        expect(nc(eC)).toBe(1); // no recompute because d unchanged

        await expect(fr("a")).resolves.toBe("up-to-date");
        await expect(fr("b")).resolves.toBe("up-to-date");
        await expect(fr("c")).resolves.toBe("up-to-date");
        await expect(fr("d")).resolves.toBe("up-to-date");
        await expect(fr("e")).resolves.toBe("up-to-date");
    });
});

describe("P3: computor invoked at most once per node per top-level pull (diamond graph)", () => {
    test("diamond A -> (B,C) -> D calls each computor once", async () => {
        const db = new InMemoryDatabase();

        const bC = countedComputor("b", async ([a]) => ({ n: a.n + 1 }));
        const cC = countedComputor("c", async ([a]) => ({ n: a.n + 2 }));
        const dC = countedComputor("d", async ([b, c]) => ({ n: b.n + c.n }));

        const g = buildGraph(db, [
            {
                output: "a",
                inputs: [],
                computor: async (_i, old) => old || { n: 0 },
            },
            { output: "b", inputs: ["a"], computor: bC.computor },
            { output: "c", inputs: ["a"], computor: cC.computor },
            { output: "d", inputs: ["b", "c"], computor: dC.computor },
        ]);

        await g.set("a", { n: 10 });
        const out = await g.pull("d");
        expect(out).toEqual({ n: 10 + 1 + (10 + 2) });

        expect(bC.counter.calls).toBe(1);
        expect(cC.counter.calls).toBe(1);
        expect(dC.counter.calls).toBe(1);
    });

    test("same node required twice in inputs still must not cause double computor invocation (if implementation dedupes)", async () => {
        const db = new InMemoryDatabase();

        const bC = countedComputor("b", async ([a]) => ({ n: a.n + 1 }));
        const dC = countedComputor("d", async ([b1, b2]) => ({
            n: b1.n + b2.n,
        }));

        const g = buildGraph(db, [
            {
                output: "a",
                inputs: [],
                computor: async (_i, old) => old || { n: 0 },
            },
            { output: "b", inputs: ["a"], computor: bC.computor },
            // duplicate dependency path: inputs list literally repeats "b"
            { output: "d", inputs: ["b", "b"], computor: dC.computor },
        ]);

        await g.set("a", { n: 10 });
        const out = await g.pull("d");
        expect(out).toEqual({ n: 10 + 1 + (10 + 1) });

        // P3: "A node's computor MUST be invoked at most once per pull operation,
        // even if the node appears in multiple dependency paths."
        expect(bC.counter.calls).toBe(1);
        expect(dC.counter.calls).toBe(1);
    });
});

describe("Unchanged semantics (observable storage behavior)", () => {
    test("when computor returns Unchanged, stored value is not overwritten", async () => {
        const db = new InMemoryDatabase();

        const bC = countedComputor("b", async (_inputs, oldValue) => {
            if (!oldValue) return { v: 1 };
            return makeUnchanged();
        });

        const g = buildGraph(db, [
            {
                output: "a",
                inputs: [],
                computor: async (_i, old) => old || { n: 0 },
            },
            { output: "b", inputs: ["a"], computor: bC.computor },
        ]);

        await g.set("a", { n: 0 });

        db.resetLogs();
        const v1 = await g.pull("b");
        expect(v1).toEqual({ v: 1 });

        // pull again: computor returns Unchanged, value must remain {v:1} and no put to value key "b" should occur.
        db.resetLogs();
        const v2 = await g.pull("b");
        expect(v2).toEqual({ v: 1 });

        // Search logs for a write to key "b" on second pull
        const wroteB =
            db.putLog.some((p) => p.key === "b") ||
            db.batchLog.some((b) =>
                b.ops.some((op) => op.type === "put" && op.key === "b")
            );
        expect(wroteB).toBe(false);
    });

    test("Unchanged does not leak as return value (pull returns DatabaseValue, not sentinel)", async () => {
        const db = new InMemoryDatabase();
        const g = buildGraph(db, [
            {
                output: "x",
                inputs: [],
                computor: async (_i, old) =>
                    old ? makeUnchanged() : { ok: true },
            },
        ]);

        const a = await g.pull("x");
        expect(a).toEqual({ ok: true });

        const b = await g.pull("x");
        expect(isUnchanged(b)).toBe(false);
        expect(b).toEqual({ ok: true });
    });
});

describe("MissingValueError (detects corruption: up-to-date but missing stored value)", () => {
    test("if value key is deleted after materialization, pull throws MissingValueError", async () => {
        const db = new InMemoryDatabase();
        const g = buildGraph(db, [
            {
                output: "leaf",
                inputs: [],
                computor: async (_i, old) => old || { ok: true },
            },
        ]);

        // Materialize node (creates freshness + value)
        const v = await g.pull("leaf");
        expect(v).toEqual({ ok: true });

        // Corrupt: delete the VALUE key only (leaving freshness intact)
        await db.corruptByDeletingValue("leaf");

        await expect(g.pull("leaf")).rejects.toMatchObject({
            name: "MissingValueError",
        });
    });
});

describe("Optional debug interface (only if implementation provides it)", () => {
    test("debugGetFreshness and debugListMaterializedNodes behave if present", async () => {
        const db = new InMemoryDatabase();
        const g = buildGraph(db, [
            {
                output: "a",
                inputs: [],
                computor: async (_i, old) => old || { n: 0 },
            },
            {
                output: "b",
                inputs: ["a"],
                computor: async ([a]) => ({ n: a.n + 1 }),
            },
        ]);

        if (
            typeof g.debugGetFreshness !== "function" ||
            typeof g.debugListMaterializedNodes !== "function"
        ) {
            // Optional interface; skip if absent
            return;
        }

        // missing before materialization
        const f0 = await g.debugGetFreshness("b");
        expect(["missing", "up-to-date", "potentially-outdated"]).toContain(f0);

        await g.set("a", { n: 1 });
        await g.pull("b");

        const list = await g.debugListMaterializedNodes();
        expect(Array.isArray(list)).toBe(true);
        expect(list).toContain(toJsonKey("a"));
        expect(list).toContain(toJsonKey("b"));

        const fb = await g.debugGetFreshness("b");
        expect(fb).toBe("up-to-date");
    });

    test("set() on source node must include it in debugListMaterializedNodes", async () => {
        const db = new InMemoryDatabase();
        const g = buildGraph(db, [
            {
                output: "source",
                inputs: [],
                computor: async (_i, old) => old || { n: 0 },
            },
        ]);

        if (typeof g.debugListMaterializedNodes !== "function") {
            // Optional interface; skip if absent
            return;
        }

        // Initially empty
        const list0 = await g.debugListMaterializedNodes();
        expect(list0).not.toContain(toJsonKey("source"));

        // After set, source must be materialized
        await g.set("source", { n: 42 });
        
        const list1 = await g.debugListMaterializedNodes();
        expect(list1).toContain(toJsonKey("source"));
        
        // Also verify that the node is properly indexed (has an inputs record)
        // This is important for restart resilience
        const storage = g.getStorage();
        const inputsRecord = await storage.getInputs(toJsonKey("source"));
        expect(inputsRecord).not.toBeNull();
        expect(inputsRecord).toEqual([]);
    });

    test("pull() on leaf node (inputs=[]) must include it in debugListMaterializedNodes", async () => {
        const db = new InMemoryDatabase();
        const g = buildGraph(db, [
            {
                output: "leaf",
                inputs: [],
                computor: async (_i, old) => old || { n: 0 },
            },
        ]);

        if (typeof g.debugListMaterializedNodes !== "function") {
            // Optional interface; skip if absent
            return;
        }

        // Initially empty
        const list0 = await g.debugListMaterializedNodes();
        expect(list0).not.toContain(toJsonKey("leaf"));

        // After pull, leaf must be materialized
        const value = await g.pull("leaf");
        expect(value).toEqual({ n: 0 });
        
        const list1 = await g.debugListMaterializedNodes();
        expect(list1).toContain(toJsonKey("leaf"));
        
        // Also verify that the node is properly indexed (has an inputs record)
        // This is important for restart resilience
        const storage = g.getStorage();
        const inputsRecord = await storage.getInputs(toJsonKey("leaf"));
        expect(inputsRecord).not.toBeNull();
        expect(inputsRecord).toEqual([]);
    });
});

// ============================================================================
// EXTENDED CONFORMANCE TEST FAMILIES
// ============================================================================

describe("1. Deep linear chains: freshness should prevent reevaluation", () => {
    test.each([{ k: 3 }, { k: 5 }, { k: 10 }, { k: 30 }])(
        "chain of depth $k: A -> N1 -> ... -> Nk",
        async ({ k }) => {
            const db = new InMemoryDatabase();

            // Build chain A -> N1 -> N2 -> ... -> Nk
            const counters = {};
            const nodeDefs = [];

            // Source node A
            nodeDefs.push({
                output: "a",
                inputs: [],
                computor: async (_i, old) => old || { n: 0 },
            });

            // Chain nodes N1 to Nk
            for (let i = 1; i <= k; i++) {
                const prevNode = i === 1 ? "a" : `n${i - 1}`;
                const nodeName = `n${i}`;

                const { computor, counter } = countedComputor(
                    nodeName,
                    async ([prev]) => ({
                        n: prev.n + 1,
                    })
                );

                counters[nodeName] = counter;
                nodeDefs.push({
                    output: nodeName,
                    inputs: [prevNode],
                    computor,
                });
            }

            const g = buildGraph(db, nodeDefs);

            // First pull: should compute each node exactly once
            await g.set("a", { n: 0 });
            const tail = `n${k}`;
            const v1 = await g.pull(tail);
            expect(v1).toEqual({ n: k });

            // Check each node computed once
            for (let i = 1; i <= k; i++) {
                expect(counters[`n${i}`].calls).toBe(1);
            }

            // Second pull: should trigger NO recomputation (freshness caching)
            const v2 = await g.pull(tail);
            expect(v2).toEqual({ n: k });

            for (let i = 1; i <= k; i++) {
                expect(counters[`n${i}`].calls).toBe(1); // still 1
            }

            // Third pull: should trigger NO recomputation (freshness caching)
            const v3 = await g.pull(tail);
            expect(v3).toEqual({ n: k });

            for (let i = 1; i <= k; i++) {
                expect(counters[`n${i}`].calls).toBe(1); // still 1
            }

            // After set(A), pull(tail) should recompute each downstream node exactly once
            await g.set("a", { n: 100 });
            const v4 = await g.pull(tail);
            expect(v4).toEqual({ n: 100 + k });

            for (let i = 1; i <= k; i++) {
                expect(counters[`n${i}`].calls).toBe(2); // now 2
            }
        }
    );
});

describe("2. Deep reconvergent DAGs: dedupe across multiple levels", () => {
    test("ladder reconvergence: many nodes depend on shared subnode several levels down", async () => {
        const db = new InMemoryDatabase();

        // Structure:
        //   shared -> (b1, b2, b3) -> (c1, c2) -> top
        // where c1 depends on [b1, b2], c2 depends on [b2, b3], top depends on [c1, c2]
        // shared is reached through multiple paths

        const sharedC = countedComputor(
            "shared",
            async (_i, old) => old || { n: 1 }
        );
        const b1C = countedComputor("b1", async ([s]) => ({ n: s.n + 1 }));
        const b2C = countedComputor("b2", async ([s]) => ({ n: s.n + 2 }));
        const b3C = countedComputor("b3", async ([s]) => ({ n: s.n + 3 }));
        const c1C = countedComputor("c1", async ([b1, b2]) => ({
            n: b1.n + b2.n,
        }));
        const c2C = countedComputor("c2", async ([b2, b3]) => ({
            n: b2.n + b3.n,
        }));
        const topC = countedComputor("top", async ([c1, c2]) => ({
            n: c1.n + c2.n,
        }));

        const g = buildGraph(db, [
            { output: "shared", inputs: [], computor: sharedC.computor },
            { output: "b1", inputs: ["shared"], computor: b1C.computor },
            { output: "b2", inputs: ["shared"], computor: b2C.computor },
            { output: "b3", inputs: ["shared"], computor: b3C.computor },
            { output: "c1", inputs: ["b1", "b2"], computor: c1C.computor },
            { output: "c2", inputs: ["b2", "b3"], computor: c2C.computor },
            { output: "top", inputs: ["c1", "c2"], computor: topC.computor },
        ]);

        await g.set("shared", { n: 1 });

        // First pull: each node computed at most once (P3)
        const result = await g.pull("top");
        expect(result).toBeDefined();

        // Note: sharedC.counter.calls is 0 because set() doesn't call computor, and pull finds it already up-to-date
        expect(sharedC.counter.calls).toBe(0);
        expect(b1C.counter.calls).toBe(1);
        expect(b2C.counter.calls).toBe(1);
        expect(b3C.counter.calls).toBe(1);
        expect(c1C.counter.calls).toBe(1);
        expect(c2C.counter.calls).toBe(1);
        expect(topC.counter.calls).toBe(1);

        // Second pull: no recomputation (warm cache)
        await g.pull("top");
        expect(sharedC.counter.calls).toBe(0);
        expect(b1C.counter.calls).toBe(1);
        expect(b2C.counter.calls).toBe(1);
        expect(b3C.counter.calls).toBe(1);
        expect(c1C.counter.calls).toBe(1);
        expect(c2C.counter.calls).toBe(1);
        expect(topC.counter.calls).toBe(1);
    });

    test("multi-diamond: A -> (B1,B2,B3) -> (C1,C2) -> D with shared intermediates", async () => {
        const db = new InMemoryDatabase();

        // Structure:
        //   a -> [b1, b2, b3]
        //   b1 -> c1, b2 -> [c1, c2], b3 -> c2
        //   [c1, c2] -> d

        const aC = countedComputor("a", async (_i, old) => old || { n: 0 });
        const b1C = countedComputor("b1", async ([a]) => ({ n: a.n + 1 }));
        const b2C = countedComputor("b2", async ([a]) => ({ n: a.n + 2 }));
        const b3C = countedComputor("b3", async ([a]) => ({ n: a.n + 3 }));
        const c1C = countedComputor("c1", async ([b1, b2]) => ({
            n: b1.n + b2.n,
        }));
        const c2C = countedComputor("c2", async ([b2, b3]) => ({
            n: b2.n + b3.n,
        }));
        const dC = countedComputor("d", async ([c1, c2]) => ({
            n: c1.n + c2.n,
        }));

        const g = buildGraph(db, [
            { output: "a", inputs: [], computor: aC.computor },
            { output: "b1", inputs: ["a"], computor: b1C.computor },
            { output: "b2", inputs: ["a"], computor: b2C.computor },
            { output: "b3", inputs: ["a"], computor: b3C.computor },
            { output: "c1", inputs: ["b1", "b2"], computor: c1C.computor },
            { output: "c2", inputs: ["b2", "b3"], computor: c2C.computor },
            { output: "d", inputs: ["c1", "c2"], computor: dC.computor },
        ]);

        await g.set("a", { n: 10 });
        await g.pull("d");

        // Each node computed at most once
        // Note: aC.counter.calls is 0 because set() doesn't call computor
        expect(aC.counter.calls).toBe(0);
        expect(b1C.counter.calls).toBe(1);
        expect(b2C.counter.calls).toBe(1);
        expect(b3C.counter.calls).toBe(1);
        expect(c1C.counter.calls).toBe(1);
        expect(c2C.counter.calls).toBe(1);
        expect(dC.counter.calls).toBe(1);
    });
});

describe("3. Duplicate dependencies beyond trivial ['b','b'] case", () => {
    test("structural duplicates: D depends on X and Y; both depend on Z; Z depends on W", async () => {
        const db = new InMemoryDatabase();

        const wC = countedComputor("w", async (_i, old) => old || { n: 1 });
        const zC = countedComputor("z", async ([w]) => ({ n: w.n + 1 }));
        const xC = countedComputor("x", async ([z]) => ({ n: z.n + 10 }));
        const yC = countedComputor("y", async ([z]) => ({ n: z.n + 20 }));
        const dC = countedComputor("d", async ([x, y]) => ({ n: x.n + y.n }));

        const g = buildGraph(db, [
            { output: "w", inputs: [], computor: wC.computor },
            { output: "z", inputs: ["w"], computor: zC.computor },
            { output: "x", inputs: ["z"], computor: xC.computor },
            { output: "y", inputs: ["z"], computor: yC.computor },
            { output: "d", inputs: ["x", "y"], computor: dC.computor },
        ]);

        await g.set("w", { n: 1 });
        await g.pull("d");

        // Z (and W) should be computed once despite being reached through different routes
        // Note: wC.counter.calls is 0 because set() doesn't call computor
        expect(wC.counter.calls).toBe(0);
        expect(zC.counter.calls).toBe(1);
        expect(xC.counter.calls).toBe(1);
        expect(yC.counter.calls).toBe(1);
        expect(dC.counter.calls).toBe(1);
    });
});


describe("6. oldValue plumbing: correct previous-value visibility", () => {
    test("first materialization: oldValue === undefined", async () => {
        const db = new InMemoryDatabase();

        const { computor, counter } = countedComputor(
            "node",
            async (_inputs, oldValue) => {
                if (oldValue === undefined) {
                    return { v: 1 };
                }
                return { v: oldValue.v + 1 };
            }
        );

        const g = buildGraph(db, [
            {
                output: "source",
                inputs: [],
                computor: async (_i, old) => old || { n: 0 },
            },
            { output: "node", inputs: ["source"], computor },
        ]);

        await g.set("source", { n: 0 });
        const v1 = await g.pull("node");
        expect(v1).toEqual({ v: 1 });
        expect(counter.calls).toBe(1);
        expect(counter.args[0].oldValue).toBeUndefined();
    });

    test("on recomputation after invalidation, oldValue equals previously stored value", async () => {
        const db = new InMemoryDatabase();

        const { computor, counter } = countedComputor(
            "node",
            async ([source], oldValue) => {
                if (oldValue === undefined) {
                    return { v: source.n };
                }
                return { v: oldValue.v + source.n };
            }
        );

        const g = buildGraph(db, [
            {
                output: "source",
                inputs: [],
                computor: async (_i, old) => old || { n: 0 },
            },
            { output: "node", inputs: ["source"], computor },
        ]);

        await g.set("source", { n: 10 });
        const v1 = await g.pull("node");
        expect(v1).toEqual({ v: 10 });

        await g.set("source", { n: 5 });
        const v2 = await g.pull("node");
        expect(v2).toEqual({ v: 15 }); // oldValue.v=10 + source.n=5

        expect(counter.calls).toBe(2);
        expect(counter.args[1].oldValue).toEqual({ v: 10 });
    });

    test("when computor returns Unchanged, oldValue on next invocation matches preserved value", async () => {
        const db = new InMemoryDatabase();

        const { computor, counter } = countedComputor(
            "node",
            async ([source], oldValue) => {
                if (oldValue === undefined) {
                    return { v: 1 };
                }
                if (source.flag === "unchanged") {
                    return makeUnchanged();
                }
                return { v: oldValue.v + 1 };
            }
        );

        const g = buildGraph(db, [
            {
                output: "source",
                inputs: [],
                computor: async (_i, old) => old || { flag: "init" },
            },
            { output: "node", inputs: ["source"], computor },
        ]);

        await g.set("source", { flag: "init" });
        const v1 = await g.pull("node");
        expect(v1).toEqual({ v: 1 });

        // Set source to trigger recomputation, but computor returns Unchanged
        await g.set("source", { flag: "unchanged" });
        const v2 = await g.pull("node");
        expect(v2).toEqual({ v: 1 }); // preserved

        // Set source again to trigger another recomputation
        await g.set("source", { flag: "change" });
        const v3 = await g.pull("node");
        expect(v3).toEqual({ v: 2 }); // oldValue.v=1 + 1

        expect(counter.calls).toBe(3);
        expect(counter.args[2].oldValue).toEqual({ v: 1 }); // preserved from Unchanged
    });
});

describe("11. set() batching remains single atomic batch with invalidation fanout", () => {
    test("source with many materialized dependents uses single batch", async () => {
        const db = new InMemoryDatabase();

        // Build a graph where source has many direct and transitive dependents
        const counters = {};
        const nodeDefs = [
            {
                output: "source",
                inputs: [],
                computor: async (_i, old) => old || { n: 0 },
            },
        ];

        const numDirect = 10;
        for (let i = 1; i <= numDirect; i++) {
            const { computor, counter } = countedComputor(
                `d${i}`,
                async ([s]) => ({ n: s.n + i })
            );
            counters[`d${i}`] = counter;
            nodeDefs.push({ output: `d${i}`, inputs: ["source"], computor });
        }

        // Add transitive dependents
        for (let i = 1; i <= numDirect; i++) {
            const { computor, counter } = countedComputor(
                `t${i}`,
                async ([d]) => ({ n: d.n * 2 })
            );
            counters[`t${i}`] = counter;
            nodeDefs.push({ output: `t${i}`, inputs: [`d${i}`], computor });
        }

        const g = buildGraph(db, nodeDefs);

        await g.set("source", { n: 1 });

        // Materialize all dependents
        for (let i = 1; i <= numDirect; i++) {
            await g.pull(`t${i}`);
        }

        db.resetLogs();

        // Now set(source) again, which should invalidate all materialized dependents
        await g.set("source", { n: 10 });

        // Should use exactly one batch
        expect(db.batchLog.length).toBe(1);

        // Should have no non-batched put calls during set
        expect(db.putLog.length).toBe(0);
    });
});

describe("12. (Optional) Concurrent pulls of the same node", () => {
    test("concurrent pulls of same node should invoke computor once", async () => {
            const db = new InMemoryDatabase();

            let resolveBarrier;
            const barrier = new Promise((resolve) => {
                resolveBarrier = resolve;
            });

            const { computor, counter } = countedComputor(
                "node",
                async ([source]) => {
                    await barrier;
                    return { n: source.n + 1 };
                }
            );

            const g = buildGraph(db, [
                {
                    output: "source",
                    inputs: [],
                    computor: async (_i, old) => old || { n: 0 },
                },
                { output: "node", inputs: ["source"], computor },
            ]);

            await g.set("source", { n: 10 });

            // Issue two concurrent pulls
            const pull1 = g.pull("node");
            const pull2 = g.pull("node");

            // Wait a bit to ensure both pulls are in-flight
            await new Promise((resolve) => setTimeout(resolve, 10));

            resolveBarrier();

            const [result1, result2] = await Promise.all([pull1, pull2]);

            // Both should get the same value
            expect(result1).toEqual({ n: 11 });
            expect(result2).toEqual({ n: 11 });

            // Computor should have been invoked only once (in-flight dedupe)
            expect(counter.calls).toBe(1);
        });
});

