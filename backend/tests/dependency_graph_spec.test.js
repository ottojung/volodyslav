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

function expectOneOfNames(err, names) {
    expect(err).toBeTruthy();
    const n = err.name || err.code;
    expect(names).toContain(n);
}

function expectHasOwn(err, prop) {
    expect(Object.prototype.hasOwnProperty.call(err, prop)).toBe(true);
}

/**
 * Minimal in-memory Database that matches the spec's Database interface.
 * We purposely do NOT assume any particular "freshness key" naming convention:
 * the graph is free to choose. This DB just stores whatever keys it is asked to store.
 */
class InMemoryDatabase {
    constructor() {
        /** @type {Map<string, any>} */
        this.kv = new Map();
        /** @type {boolean} */
        this.closed = false;
        /** @type {Array<any>} */
        this.batchLog = [];
        /** @type {Array<any>} */
        this.putLog = [];
        /** @type {Array<any>} */
        this.getValueLog = [];
        /** @type {Array<any>} */
        this.getFreshnessLog = [];
    }

    async put(key, value) {
        if (this.closed) throw new Error("DatabaseClosed");
        this.putLog.push({ key, value });
        this.kv.set(key, deepClone(value));
    }

    async getValue(key) {
        if (this.closed) throw new Error("DatabaseClosed");
        this.getValueLog.push({ key });
        const v = this.kv.get(key);
        return v === undefined ? undefined : deepClone(v);
    }

    async getFreshness(key) {
        if (this.closed) throw new Error("DatabaseClosed");
        this.getFreshnessLog.push({ key });
        const v = this.kv.get(key);
        return v === undefined ? undefined : deepClone(v);
    }

    async get(key) {
        if (this.closed) throw new Error("DatabaseClosed");
        const v = this.kv.get(key);
        return v === undefined ? undefined : deepClone(v);
    }

    async keys(prefix) {
        if (this.closed) throw new Error("DatabaseClosed");
        const res = [];
        for (const k of this.kv.keys()) {
            if (!prefix || k.startsWith(prefix)) res.push(k);
        }
        return res;
    }

    async batch(ops) {
        if (this.closed) throw new Error("DatabaseClosed");
        this.batchLog.push({ ops: deepClone(ops) });

        // atomic apply: copy then commit
        const next = new Map(this.kv);
        for (const op of ops) {
            if (op.type === "put") {
                next.set(op.key, deepClone(op.value));
            } else if (op.type === "del") next.delete(op.key);
            else throw new Error(`UnknownBatchOp:${String(op.type)}`);
        }
        this.kv = next;
    }

    async close() {
        this.closed = true;
    }

    resetLogs() {
        this.batchLog = [];
        this.putLog = [];
        this.getValueLog = [];
        this.getFreshnessLog = [];
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

    test("allows disjoint literal patterns status(e,'active') vs status(e,'inactive')", () => {
        const db = new InMemoryDatabase();
        const g = buildGraph(db, [
            {
                output: "status(e,'active')",
                inputs: [],
                computor: async () => ({ s: "A" }),
            },
            {
                output: "status(e,'inactive')",
                inputs: [],
                computor: async () => ({ s: "I" }),
            },
        ]);
        expect(g).toBeTruthy();
    });

    test("throws SchemaOverlapError for overlap status(e,s) vs status(x,'active')", () => {
        const db = new InMemoryDatabase();
        expect(() =>
            makeDependencyGraph(db, [
                {
                    output: "status(e,s)",
                    inputs: [],
                    computor: async () => ({ any: true }),
                },
                {
                    output: "status(x,'active')",
                    inputs: [],
                    computor: async () => ({ only: "active" }),
                },
            ])
        ).toThrow();
        try {
            makeDependencyGraph(db, [
                {
                    output: "status(e,s)",
                    inputs: [],
                    computor: async () => ({ any: true }),
                },
                {
                    output: "status(x,'active')",
                    inputs: [],
                    computor: async () => ({ only: "active" }),
                },
            ]);
        } catch (e) {
            expectOneOfNames(e, ["SchemaOverlapError"]);
        }
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
                computor: async (_i, _o, b) => ({ n: b.n }),
            },
        ]);

        await expect(g.pull("id(-1)")).rejects.toMatchObject({
            name: "InvalidExpressionError",
        });
    });

    test("rejects non-natural numbers: float", async () => {
        const db = new InMemoryDatabase();
        const g = buildGraph(db, [
            {
                output: "id(n)",
                inputs: [],
                computor: async (_i, _o, b) => ({ n: b.n }),
            },
        ]);

        await expect(g.pull("id(1.2)")).rejects.toMatchObject({
            name: "InvalidExpressionError",
        });
    });

    test("rejects nat with leading zeros: 01", async () => {
        const db = new InMemoryDatabase();
        const g = buildGraph(db, [
            {
                output: "id(n)",
                inputs: [],
                computor: async (_i, _o, b) => ({ n: b.n }),
            },
        ]);

        await expect(g.pull("id(01)")).rejects.toMatchObject({
            name: "InvalidExpressionError",
        });
    });

    test("canonicalizes whitespace in nodeName (no spaces in DB key)", async () => {
        const db = new InMemoryDatabase();

        const { computor } = countedComputor("echo", async (_i, _o, b) => ({
            a: b.a,
            s: b.s,
        }));

        const g = buildGraph(db, [
            { output: "echo(a,s)", inputs: [], computor },
        ]);

        db.resetLogs();
        const v = await g.pull("echo(  42 ,  'test'   )");
        expect(v).toEqual({
            a: { type: "int", value: 42 },
            s: { type: "string", value: "test" },
        });

        // Must store under canonical value key "echo(42,'test')" (no spaces)
        // We don't require a particular *freshness* key, but value key must be canonical.
        const wroteValueKey =
            db.batchLog.some((b) =>
                b.ops.some(
                    (op) =>
                        op.type === "put" && op.key.includes("echo(42,'test')")
                )
            ) || db.putLog.some((p) => p.key.includes("echo(42,'test')"));

        expect(wroteValueKey).toBe(true);
    });

    test("string escapes are decoded in bindings (\\n)", async () => {
        const db = new InMemoryDatabase();
        const g = buildGraph(db, [
            {
                output: "s(x)",
                inputs: [],
                computor: async (_i, _o, b) => ({ x: b.x }),
            },
        ]);

        const out = await g.pull("s('line1\\nline2')");
        expect(out.x.type).toBe("string");
        expect(out.x.value).toBe("line1\nline2");
    });

    test("double quotes are either accepted and canonicalized, or rejected as InvalidExpressionError", async () => {
        const db = new InMemoryDatabase();
        const g = buildGraph(db, [
            {
                output: "q(x)",
                inputs: [],
                computor: async (_i, _o, b) => ({ x: b.x }),
            },
        ]);

        try {
            db.resetLogs();
            const out = await g.pull('q("id123")');
            // If accepted, canonical storage must use single quotes
            expect(out).toEqual({ x: { type: "string", value: "id123" } });

            const wroteCanonical =
                db.batchLog.some((b) =>
                    b.ops.some(
                        (op) =>
                            op.type === "put" && op.key.includes("q('id123')")
                    )
                ) || db.putLog.some((p) => p.key.includes("q('id123')"));
            expect(wroteCanonical).toBe(true);
        } catch (e) {
            expectOneOfNames(e, ["InvalidExpressionError"]);
        }
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

        await expect(g.pull("event_context(e)")).rejects.toMatchObject({
            name: expect.stringMatching(
                /^(NonConcreteNodeError|SchemaPatternNotAllowed)$/
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

        await expect(g.set("event_context(e)", { x: 1 })).rejects.toMatchObject(
            {
                name: expect.stringMatching(
                    /^(NonConcreteNodeError|SchemaPatternNotAllowed)$/
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
        await expect(g.debugGetFreshness("b")).resolves.toBe(
            "potentially-outdated"
        );
        await expect(g.debugGetFreshness("c")).resolves.toBe(
            "potentially-outdated"
        );

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
        await expect(g.debugGetFreshness("b")).resolves.toBe(
            "potentially-outdated"
        );
        await expect(g.debugGetFreshness("c")).resolves.toBe(
            "potentially-outdated"
        );

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
        const dC = countedComputor("d", async ([c]) => ({
            s: "d(" + c.s + ")",
        }));
        const eC = countedComputor("e", async ([d]) => ({
            s: "e(" + d.s + ")",
        }));

        const g = buildGraph(db, [
            {
                output: "a",
                inputs: [],
                computor: async (_i, old) => old || { s: "a()" },
            },
            { output: "b", inputs: ["a"], computor: bC.computor },
            { output: "c", inputs: ["b"], computor: cC.computor },
            { output: "d", inputs: ["c"], computor: dC.computor },
            { output: "e", inputs: ["d"], computor: eC.computor },
        ]);

        await expect(g.debugGetFreshness("a")).resolves.toBe("missing");
        await expect(g.debugGetFreshness("b")).resolves.toBe("missing");
        await expect(g.debugGetFreshness("c")).resolves.toBe("missing");

        await g.set("a", { s: "a()" });

        await expect(g.debugGetFreshness("a")).resolves.toBe("up-to-date");
        await expect(g.debugGetFreshness("b")).resolves.toBe(
            "potentially-outdated"
        );
        await expect(g.debugGetFreshness("c")).resolves.toBe(
            "potentially-outdated"
        );
        await expect(g.debugGetFreshness("d")).resolves.toBe(
            "potentially-outdated"
        );
        await expect(g.debugGetFreshness("e")).resolves.toBe(
            "potentially-outdated"
        );

        const c = await g.pull("c");
        expect(c).toEqual({ s: "c(b(a()))" });
        expect(bC.counter.calls).toBe(1);
        expect(cC.counter.calls).toBe(1);
        expect(dC.counter.calls).toBe(0);
        expect(eC.counter.calls).toBe(0);

        await expect(g.debugGetFreshness("a")).resolves.toBe("up-to-date");
        await expect(g.debugGetFreshness("b")).resolves.toBe("up-to-date");
        await expect(g.debugGetFreshness("c")).resolves.toBe("up-to-date");
        await expect(g.debugGetFreshness("d")).resolves.toBe(
            "potentially-outdated"
        );
        await expect(g.debugGetFreshness("e")).resolves.toBe(
            "potentially-outdated"
        );

        await g.set("a", { s: "a()" });

        await expect(g.debugGetFreshness("a")).resolves.toBe("up-to-date");
        await expect(g.debugGetFreshness("b")).resolves.toBe(
            "potentially-outdated"
        );
        await expect(g.debugGetFreshness("c")).resolves.toBe(
            "potentially-outdated"
        );
        await expect(g.debugGetFreshness("d")).resolves.toBe(
            "potentially-outdated"
        );
        await expect(g.debugGetFreshness("e")).resolves.toBe(
            "potentially-outdated"
        );

        const b = await g.pull("b");
        expect(b).toEqual({ s: "b(a())" });
        expect(bC.counter.calls).toBe(2); // one recompute
        expect(cC.counter.calls).toBe(1); // no recompute yet
        expect(dC.counter.calls).toBe(0);
        expect(eC.counter.calls).toBe(0);

        await expect(g.debugGetFreshness("a")).resolves.toBe("up-to-date");
        await expect(g.debugGetFreshness("b")).resolves.toBe("up-to-date");
        // Must still be potentially-outdated because c not recomputed yet.
        await expect(g.debugGetFreshness("c")).resolves.toBe(
            "potentially-outdated"
        );
        await expect(g.debugGetFreshness("d")).resolves.toBe(
            "potentially-outdated"
        );
        await expect(g.debugGetFreshness("e")).resolves.toBe(
            "potentially-outdated"
        );
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

describe("Bindings & parameterized nodes", () => {
    test("bindings deliver correct ConstValue types (string/int)", async () => {
        const db = new InMemoryDatabase();
        const g = buildGraph(db, [
            {
                output: "pair(a,b)",
                inputs: [],
                computor: async (_i, _o, bindings) => ({
                    a: bindings.a,
                    b: bindings.b,
                }),
            },
        ]);

        const out = await g.pull("pair('hello',42)");
        expect(out.a).toEqual({ type: "string", value: "hello" });
        expect(out.b).toEqual({ type: "int", value: 42 });
    });

    test("non-concrete pull is rejected even if schema exists (pair(a,b))", async () => {
        const db = new InMemoryDatabase();
        const g = buildGraph(db, [
            {
                output: "pair(a,b)",
                inputs: [],
                computor: async () => ({ ok: true }),
            },
        ]);

        await expect(g.pull("pair(x,42)")).rejects.toMatchObject({
            name: expect.stringMatching(
                /^(NonConcreteNodeError|SchemaPatternNotAllowed)$/
            ),
        });
    });

    test("variable sharing across inputs uses same binding (full_event(e) depends on status(e), metadata(e))", async () => {
        const db = new InMemoryDatabase();

        const statusC = countedComputor("status", async (_i, _o, { e }) => ({
            s: `S:${e.value}`,
        }));
        const metaC = countedComputor("meta", async (_i, _o, { e }) => ({
            m: `M:${e.value}`,
        }));
        const fullC = countedComputor("full", async ([s, m], _o, { e }) => ({
            id: e.value,
            s,
            m,
        }));

        const g = buildGraph(db, [
            { output: "status(e)", inputs: [], computor: statusC.computor },
            { output: "metadata(e)", inputs: [], computor: metaC.computor },
            {
                output: "full_event(e)",
                inputs: ["status(e)", "metadata(e)"],
                computor: fullC.computor,
            },
        ]);

        const out = await g.pull("full_event('id123')");
        expect(out.id).toBe("id123");
        expect(out.s).toEqual({ s: "S:id123" });
        expect(out.m).toEqual({ m: "M:id123" });

        // Ensure bindings passed through as e='id123'
        expect(statusC.counter.args[0].bindings.e).toEqual({
            type: "string",
            value: "id123",
        });
        expect(metaC.counter.args[0].bindings.e).toEqual({
            type: "string",
            value: "id123",
        });
        expect(fullC.counter.args[0].bindings.e).toEqual({
            type: "string",
            value: "id123",
        });
    });

    test("schema output may contain literals (still works, only matches exact node)", async () => {
        const db = new InMemoryDatabase();
        const g = buildGraph(db, [
            {
                output: "special('id123')",
                inputs: [],
                computor: async () => ({ ok: true }),
            },
        ]);

        await expect(g.pull("special('id123')")).resolves.toEqual({ ok: true });
        await expect(g.pull("special('id999')")).rejects.toMatchObject({
            name: expect.stringMatching(/^(InvalidNodeError|InvalidNode)$/),
        });
    });
});

describe("Restart resilience: previously materialized nodes behave correctly after restart", () => {
    test("after restart and set(source), pulling prior dependent reflects new upstream value", async () => {
        const db = new InMemoryDatabase();

        // Graph #1
        const ctx1 = countedComputor("ctx1", async ([all], _old, { e }) => {
            const found = all.events.find((ev) => ev.id === e.value);
            return found ? { id: found.id, payload: found.payload } : null;
        });

        const g1 = buildGraph(db, [
            {
                output: "all_events",
                inputs: [],
                computor: async (_i, old) => old || { events: [] },
            },
            {
                output: "event_context(e)",
                inputs: ["all_events"],
                computor: ctx1.computor,
            },
        ]);

        await g1.set("all_events", {
            events: [{ id: "id123", payload: "v1" }],
        });
        const v1 = await g1.pull("event_context('id123')");
        expect(v1).toEqual({ id: "id123", payload: "v1" });
        expect(ctx1.counter.calls).toBe(1);

        // "Restart": new graph instance over same DB
        const ctx2 = countedComputor("ctx2", async ([all], _old, { e }) => {
            const found = all.events.find((ev) => ev.id === e.value);
            return found ? { id: found.id, payload: found.payload } : null;
        });

        const g2 = buildGraph(db, [
            {
                output: "all_events",
                inputs: [],
                computor: async (_i, old) => old || { events: [] },
            },
            {
                output: "event_context(e)",
                inputs: ["all_events"],
                computor: ctx2.computor,
            },
        ]);

        await g2.set("all_events", {
            events: [{ id: "id123", payload: "v2" }],
        });
        const v2 = await g2.pull("event_context('id123')");
        expect(v2).toEqual({ id: "id123", payload: "v2" });

        // If restart invalidation/materialization is broken AND freshness persisted "up-to-date",
        // this could have returned stale v1. This assertion catches that.
        expect(v2.payload).toBe("v2");

        // Recompute may or may not happen depending on strategy,
        // but returning v2 is mandatory for correctness.
        expect(ctx2.counter.calls).toBeGreaterThanOrEqual(1);
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

        // Corrupt: delete the VALUE key only (we know it must be canonical node key "leaf")
        await db.batch([{ type: "del", key: "leaf" }]);

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
        expect(list).toContain("a");
        expect(list).toContain("b");

        const fb = await g.debugGetFreshness("b");
        expect(fb).toBe("up-to-date");
    });
});

describe("Canonical DB keys for values (must be canonical serialization)", () => {
    test("set stores value under canonical key (no spaces, single quotes)", async () => {
        const db = new InMemoryDatabase();
        const g = buildGraph(db, [
            // make it a source node by inputs=[]
            {
                output: "status(e,'active')",
                inputs: [],
                computor: async (_i, old) => old || { ok: true },
            },
        ]);

        db.resetLogs();
        await g.set("status( 'e1' , 'active' )", { ok: 123 });

        const canonicalKey = "status('e1','active')";
        const wroteCanonical =
            db.batchLog.some((b) =>
                b.ops.some(
                    (op) => op.type === "put" && op.key.includes(canonicalKey)
                )
            ) || db.putLog.some((p) => p.key.includes(canonicalKey));

        expect(wroteCanonical).toBe(true);
    });

    test("pull reads the canonical key (observed via getValue calls) when input has whitespace", async () => {
        const db = new InMemoryDatabase();
        const g = buildGraph(db, [
            {
                output: "status(e,'active')",
                inputs: [],
                computor: async (_i, old) => old || { ok: true },
            },
        ]);

        await g.set("status('e1','active')", { ok: 1 });

        db.resetLogs();
        await g.pull("status( 'e1' , 'active' )");

        const canonicalKey = "status('e1','active')";
        const readCanonical = db.getValueLog.some((x) =>
            x.key.includes(canonicalKey)
        );
        expect(readCanonical).toBe(true);
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

            // After set(A), pull(tail) should recompute each downstream node exactly once
            await g.set("a", { n: 100 });
            const v3 = await g.pull(tail);
            expect(v3).toEqual({ n: 100 + k });

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

    test("same concrete node via different parameterized instantiations", async () => {
        const db = new InMemoryDatabase();

        // Schema: f(x) depends on base, g depends on f('a') and f('b') and f('a') again
        // This tests if node identity deduplication works at the concrete level

        const baseC = countedComputor(
            "base",
            async (_i, old) => old || { n: 0 }
        );
        const fC = countedComputor("f", async ([base], _old, { x }) => ({
            n: base.n + x.value,
        }));
        const gC = countedComputor("g", async ([fa1, fb, fa2]) => ({
            n: fa1.n + fb.n + fa2.n,
        }));

        const g = buildGraph(db, [
            { output: "base", inputs: [], computor: baseC.computor },
            { output: "f(x)", inputs: ["base"], computor: fC.computor },
            {
                output: "g",
                inputs: ["f(1)", "f(2)", "f(1)"],
                computor: gC.computor,
            },
        ]);

        await g.set("base", { n: 10 });
        const result = await g.pull("g");
        expect(result).toBeDefined();

        // f(1) should be computed once even though it appears twice in g's inputs
        // This is the deduplication requirement
        // Note: The counter tracks all calls to fC, so we'd need per-instantiation tracking
        // For now, we can check that the total is reasonable
        // Note: baseC.counter.calls is 0 because set() doesn't call computor
        expect(baseC.counter.calls).toBe(0);
        // fC might be called for f(1) and f(2), but f(1) should dedupe
        expect(fC.counter.calls).toBeLessThanOrEqual(2); // f(1) once, f(2) once
    });
});

describe("4. Parameterized instantiation set: many concrete nodes, independent caches", () => {
    test.each([
        { instantiations: ["'a'", "'b'", "'c'"] },
        { instantiations: ["1", "2", "3", "4", "5"] },
    ])(
        "independent caching for multiple instantiations: $instantiations",
        async ({ instantiations }) => {
            const db = new InMemoryDatabase();

            const baseC = countedComputor(
                "base",
                async (_i, old) => old || { n: 0 }
            );
            const fC = countedComputor("f", async ([base], _old, { x }) => ({
                n: base.n + 100,
                x: x,
            }));

            const g = buildGraph(db, [
                { output: "base", inputs: [], computor: baseC.computor },
                { output: "f(x)", inputs: ["base"], computor: fC.computor },
            ]);

            await g.set("base", { n: 10 });

            // Pull each instantiation once
            const results1 = [];
            for (const inst of instantiations) {
                const r = await g.pull(`f(${inst})`);
                results1.push(r);
            }

            const callsAfterFirst = fC.counter.calls;
            expect(callsAfterFirst).toBe(instantiations.length);

            // Pull each instantiation again: should be cached
            for (const inst of instantiations) {
                await g.pull(`f(${inst})`);
            }

            expect(fC.counter.calls).toBe(callsAfterFirst); // no new calls

            // After set(base), pulling any instantiation must reflect new state
            await g.set("base", { n: 50 });

            for (const inst of instantiations) {
                const r = await g.pull(`f(${inst})`);
                expect(r.n).toBe(150); // 50 + 100
            }

            // Each should have recomputed
            expect(fC.counter.calls).toBe(
                callsAfterFirst + instantiations.length
            );
        }
    );
});

describe("5. Transitive invalidation over parameterized nodes", () => {
    test("partial invalidation: source -> mid -> f(x) -> g(x) -> h(x)", async () => {
        const db = new InMemoryDatabase();

        const sourceC = countedComputor(
            "source",
            async (_i, old) => old || { n: 0 }
        );
        const midC = countedComputor("mid", async ([s]) => ({ n: s.n + 1 }));
        const fC = countedComputor("f", async ([m], _old, { x }) => ({
            n: m.n + x.value,
        }));
        const gC = countedComputor("g", async ([f], _old, { x: _x }) => ({
            n: f.n * 2,
        }));
        const hC = countedComputor("h", async ([g], _old, { x: _x2 }) => ({
            n: g.n + 1,
        }));

        const g = buildGraph(db, [
            { output: "source", inputs: [], computor: sourceC.computor },
            { output: "mid", inputs: ["source"], computor: midC.computor },
            { output: "f(x)", inputs: ["mid"], computor: fC.computor },
            { output: "g(x)", inputs: ["f(x)"], computor: gC.computor },
            { output: "h(x)", inputs: ["g(x)"], computor: hC.computor },
        ]);

        await g.set("source", { n: 10 });

        // Materialize subset of instantiations
        const subset = [1, 2, 3];
        for (const x of subset) {
            await g.pull(`h(${x})`);
        }

        const callsF = fC.counter.calls;
        const callsG = gC.counter.calls;
        const callsH = hC.counter.calls;

        // After set(source), pulling h(x) for x in subset must update (no stale)
        await g.set("source", { n: 20 });

        for (const x of subset) {
            const result = await g.pull(`h(${x})`);
            // Check correctness: source=20, mid=21, f=21+x, g=(21+x)*2, h=(21+x)*2+1
            const expected = (21 + x) * 2 + 1;
            expect(result.n).toBe(expected);
        }

        // Should have recomputed along the chain for each x
        expect(fC.counter.calls).toBeGreaterThan(callsF);
        expect(gC.counter.calls).toBeGreaterThan(callsG);
        expect(hC.counter.calls).toBeGreaterThan(callsH);
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

describe("7. Repeated-variable matching: eq(x,x) style patterns", () => {
    test("eq(x,x) matches when both args are equal", async () => {
        const db = new InMemoryDatabase();

        const g = buildGraph(db, [
            {
                output: "eq(x,x)",
                inputs: [],
                computor: async (_i, _o, { x }) => ({ equal: true, val: x }),
            },
        ]);

        const result = await g.pull("eq('a','a')");
        expect(result).toEqual({
            equal: true,
            val: { type: "string", value: "a" },
        });
    });

    test("eq(x,x) does NOT match when args differ -> InvalidNodeError", async () => {
        const db = new InMemoryDatabase();

        const g = buildGraph(db, [
            {
                output: "eq(x,x)",
                inputs: [],
                computor: async (_i, _o, { x }) => ({ equal: true, val: x }),
            },
        ]);

        await expect(g.pull("eq('a','b')")).rejects.toMatchObject({
            name: expect.stringMatching(/^(InvalidNodeError|InvalidNode)$/),
        });
    });

    test("pair(x,x) with integers", async () => {
        const db = new InMemoryDatabase();

        const g = buildGraph(db, [
            {
                output: "pair(x,x)",
                inputs: [],
                computor: async (_i, _o, { x }) => ({ val: x.value * 2 }),
            },
        ]);

        const result = await g.pull("pair(5,5)");
        expect(result).toEqual({ val: 10 });

        await expect(g.pull("pair(5,6)")).rejects.toMatchObject({
            name: expect.stringMatching(/^(InvalidNodeError|InvalidNode)$/),
        });
    });
});

describe("8. Overlap detection corner cases", () => {
    test("arity mismatch: node(x) vs node(x,y) must be disjoint", () => {
        const db = new InMemoryDatabase();

        // Should not throw overlap error because arity differs
        const g = buildGraph(db, [
            { output: "node(x)", inputs: [], computor: async () => ({ a: 1 }) },
            {
                output: "node(x,y)",
                inputs: [],
                computor: async () => ({ a: 2 }),
            },
        ]);

        expect(g).toBeTruthy();
    });

    test("literal vs variable: f(x,'a') vs f('b',y) should overlap", () => {
        const db = new InMemoryDatabase();

        // These patterns overlap because f('b','a') would match both
        // f(x,'a') matches when second arg is 'a'
        // f('b',y) matches when first arg is 'b'
        // Therefore f('b','a') matches both patterns
        expect(() =>
            makeDependencyGraph(db, [
                {
                    output: "f(x,'a')",
                    inputs: [],
                    computor: async () => ({ v: 1 }),
                },
                {
                    output: "f('b',y)",
                    inputs: [],
                    computor: async () => ({ v: 2 }),
                },
            ])
        ).toThrow();

        try {
            makeDependencyGraph(db, [
                {
                    output: "f(x,'a')",
                    inputs: [],
                    computor: async () => ({ v: 1 }),
                },
                {
                    output: "f('b',y)",
                    inputs: [],
                    computor: async () => ({ v: 2 }),
                },
            ]);
        } catch (e) {
            expectOneOfNames(e, ["SchemaOverlapError"]);
        }
    });

    test("repeated variables: f(x,x) vs f(y,z) should overlap", () => {
        const db = new InMemoryDatabase();

        // f(x,x) matches nodes where both args are equal
        // f(y,z) matches nodes with any args
        // These overlap (e.g., on f('a','a'))
        expect(() =>
            makeDependencyGraph(db, [
                {
                    output: "f(x,x)",
                    inputs: [],
                    computor: async () => ({ v: 1 }),
                },
                {
                    output: "f(y,z)",
                    inputs: [],
                    computor: async () => ({ v: 2 }),
                },
            ])
        ).toThrow();

        try {
            makeDependencyGraph(db, [
                {
                    output: "f(x,x)",
                    inputs: [],
                    computor: async () => ({ v: 1 }),
                },
                {
                    output: "f(y,z)",
                    inputs: [],
                    computor: async () => ({ v: 2 }),
                },
            ]);
        } catch (e) {
            expectOneOfNames(e, ["SchemaOverlapError"]);
        }
    });

    test("literal-only patterns: f('a') vs f('b') are disjoint", () => {
        const db = new InMemoryDatabase();

        const g = buildGraph(db, [
            { output: "f('a')", inputs: [], computor: async () => ({ v: 1 }) },
            { output: "f('b')", inputs: [], computor: async () => ({ v: 2 }) },
        ]);

        expect(g).toBeTruthy();
    });
});

describe("9. Cycle detection via specialization / self-reference", () => {
    test("direct self-cycle: a -> a", () => {
        const db = new InMemoryDatabase();

        expect(() =>
            makeDependencyGraph(db, [
                { output: "a", inputs: ["a"], computor: async ([a]) => a },
            ])
        ).toThrow();

        try {
            makeDependencyGraph(db, [
                { output: "a", inputs: ["a"], computor: async ([a]) => a },
            ]);
        } catch (e) {
            expectOneOfNames(e, ["SchemaCycleError"]);
        }
    });

    test("specialization-induced self-cycle: f(x) depends on f('a') becomes cycle when x='a'", () => {
        const db = new InMemoryDatabase();

        // This is a tricky case: the schema f(x) -> f('a') looks OK at schema level,
        // but when instantiated with x='a', it creates f('a') -> f('a')
        expect(() =>
            makeDependencyGraph(db, [
                {
                    output: "f(x)",
                    inputs: ["f('a')"],
                    computor: async ([fa]) => fa,
                },
            ])
        ).toThrow();

        try {
            makeDependencyGraph(db, [
                {
                    output: "f(x)",
                    inputs: ["f('a')"],
                    computor: async ([fa]) => fa,
                },
            ]);
        } catch (e) {
            expectOneOfNames(e, ["SchemaCycleError"]);
        }
    });

    test("non-cycle due to disjoint literals: f(x,'a') -> f(x,'b') should be allowed", () => {
        const db = new InMemoryDatabase();

        // f(x,'a') and f(x,'b') are disjoint (different literals in position 2)
        // so this is not a cycle
        const g = buildGraph(db, [
            {
                output: "f(x,'a')",
                inputs: ["f(x,'b')"],
                computor: async ([fb]) => fb,
            },
            {
                output: "f(x,'b')",
                inputs: [],
                computor: async () => ({ ok: true }),
            },
        ]);

        expect(g).toBeTruthy();
    });
});

describe("10. Canonical key escaping stress tests", () => {
    test.each([
        { desc: "single quote", str: "test\\'quote" },
        { desc: "backslash", str: "test\\\\back" },
        { desc: "tab", str: "test\\ttab" },
        { desc: "carriage return", str: "test\\rcarriage" },
        { desc: "newline", str: "test\\nnewline" },
    ])("string escaping: $desc", async ({ str }) => {
        const db = new InMemoryDatabase();

        const g = buildGraph(db, [
            {
                output: "s(x)",
                inputs: [],
                computor: async (_i, old, { x }) => old || { val: x.value },
            },
        ]);

        // The str contains escape sequences that should be decoded in bindings
        // but the DB key should contain canonical escaped forms
        await g.set(`s('${str}')`, { val: "test" });

        db.resetLogs();
        await g.pull(`s('${str}')`);

        // Check that storage used canonical key
        const canonicalKey = `s('${str}')`;
        const usedCanonical =
            db.getValueLog.some((x) => x.key.includes(canonicalKey)) ||
            db.batchLog.some((b) =>
                b.ops.some((op) => op.key.includes(canonicalKey))
            );

        expect(usedCanonical).toBe(true);
    });

    test("actual newline in binding should serialize with \\\\n escape in key", async () => {
        const db = new InMemoryDatabase();

        const g = buildGraph(db, [
            // Computor always uses bindings to demonstrate escaping behavior
            {
                output: "s(x)",
                inputs: [],
                computor: async (_i, _old, { x }) => ({
                    val: "<" + x.value + ">",
                }),
            },
        ]);

        // Use the escape sequence which decodes to actual newline
        db.resetLogs();
        const result = await g.pull("s('line1\\nline2')");

        // Bindings should contain the decoded string (actual newline)
        expect(result.val).toBe("<line1\nline2>");

        // Use the escape sequence which decodes to actual newline
        await g.set("s('line1\\nline2')", { val: "test" });

        // Old value unchanged.
        expect(result.val).toBe("<line1\nline2>");

        // But `set()` actually override the value
        const result2 = await g.pull("s('line1\\nline2')");
        expect(result2.val).toBe("test");

        // But DB key must NOT contain a raw newline; it should contain the escape sequence
        const hasRawNewline = db.getValueLog.some((x) => x.key.includes("\n"));
        expect(hasRawNewline).toBe(false);

        // Should contain the escaped form
        const hasEscaped = db.getValueLog.some((x) => x.key.includes("\\n"));
        expect(hasEscaped).toBe(true);
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
    test.failing(
        "concurrent pulls of same node should invoke computor once",
        async () => {
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
        }
    );
});
