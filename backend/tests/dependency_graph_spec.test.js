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
} = require('../src/generators/dependency_graph');

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
      }
      else if (op.type === "del") next.delete(op.key);
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
    counter.args.push({ inputs: deepClone(inputs), oldValue: deepClone(oldValue), bindings: deepClone(bindings) });
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
        { output: "bad(", inputs: [], computor: async () => ({ ok: true }) },
      ])
    ).toThrow();
    try {
      makeDependencyGraph(db, [
        { output: "bad(", inputs: [], computor: async () => ({ ok: true }) },
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
        { output: "node(x)", inputs: [], computor: async () => ({ a: 1 }) },
        { output: "node(y)", inputs: [], computor: async () => ({ b: 2 }) },
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
      { output: "status(e,'active')", inputs: [], computor: async () => ({ s: "A" }) },
      { output: "status(e,'inactive')", inputs: [], computor: async () => ({ s: "I" }) },
    ]);
    expect(g).toBeTruthy();
  });

  test("throws SchemaOverlapError for overlap status(e,s) vs status(x,'active')", () => {
    const db = new InMemoryDatabase();
    expect(() =>
      makeDependencyGraph(db, [
        { output: "status(e,s)", inputs: [], computor: async () => ({ any: true }) },
        { output: "status(x,'active')", inputs: [], computor: async () => ({ only: "active" }) },
      ])
    ).toThrow();
    try {
      makeDependencyGraph(db, [
        { output: "status(e,s)", inputs: [], computor: async () => ({ any: true }) },
        { output: "status(x,'active')", inputs: [], computor: async () => ({ only: "active" }) },
      ]);
    } catch (e) {
      expectOneOfNames(e, ["SchemaOverlapError"]);
    }
  });

  test("throws SchemaCycleError for a <-> b cycle", () => {
    const db = new InMemoryDatabase();
    expect(() =>
      makeDependencyGraph(db, [
        { output: "a", inputs: ["b"], computor: async ([b]) => ({ aFrom: b }) },
        { output: "b", inputs: ["a"], computor: async ([a]) => ({ bFrom: a }) },
      ])
    ).toThrow();
    try {
      makeDependencyGraph(db, [
        { output: "a", inputs: ["b"], computor: async ([b]) => ({ aFrom: b }) },
        { output: "b", inputs: ["a"], computor: async ([a]) => ({ bFrom: a }) },
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
        { output: "f(x)", inputs: ["g(x)"], computor: async ([g]) => g },
        { output: "g(x)", inputs: ["f(x)"], computor: async ([f]) => f },
      ])
    ).toThrow();
    try {
      makeDependencyGraph(db, [
        { output: "f(x)", inputs: ["g(x)"], computor: async ([g]) => g },
        { output: "g(x)", inputs: ["f(x)"], computor: async ([f]) => f },
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
      { output: "id(n)", inputs: [], computor: async (_i, _o, b) => ({ n: b.n }) },
    ]);

    await expect(g.pull("id(-1)")).rejects.toMatchObject({ name: "InvalidExpressionError" });
  });

  test("rejects non-natural numbers: float", async () => {
    const db = new InMemoryDatabase();
    const g = buildGraph(db, [
      { output: "id(n)", inputs: [], computor: async (_i, _o, b) => ({ n: b.n }) },
    ]);

    await expect(g.pull("id(1.2)")).rejects.toMatchObject({ name: "InvalidExpressionError" });
  });

  test("rejects nat with leading zeros: 01", async () => {
    const db = new InMemoryDatabase();
    const g = buildGraph(db, [
      { output: "id(n)", inputs: [], computor: async (_i, _o, b) => ({ n: b.n }) },
    ]);

    await expect(g.pull("id(01)")).rejects.toMatchObject({ name: "InvalidExpressionError" });
  });

  test("canonicalizes whitespace in nodeName (no spaces in DB key)", async () => {
    const db = new InMemoryDatabase();

    const { computor } = countedComputor("echo", async (_i, _o, b) => ({
      a: b.a,
      s: b.s,
    }));

    const g = buildGraph(db, [{ output: "echo(a,s)", inputs: [], computor }]);

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
        b.ops.some((op) => op.type === "put" && op.key.includes("echo(42,'test')"))
      ) ||
      db.putLog.some((p) => p.key.includes("echo(42,'test')"));

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
        db.batchLog.some((b) => b.ops.some((op) => op.type === "put" && op.key.includes("q('id123')"))) ||
        db.putLog.some((p) => p.key.includes("q('id123')"));
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
      { output: "event_context(e)", inputs: [], computor: async () => ({ ok: true }) },
    ]);

    await expect(g.pull("event_context(e)")).rejects.toMatchObject({
      name: expect.stringMatching(/^(NonConcreteNodeError|SchemaPatternNotAllowed)$/),
    });
  });

  test("set rejects non-concrete nodeName (free variables) with NonConcreteNodeError", async () => {
    const db = new InMemoryDatabase();
    const g = buildGraph(db, [
      { output: "event_context(e)", inputs: [], computor: async () => ({ ok: true }) },
    ]);

    await expect(g.set("event_context(e)", { x: 1 })).rejects.toMatchObject({
      name: expect.stringMatching(/^(NonConcreteNodeError|SchemaPatternNotAllowed)$/),
    });
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

  test("set on non-source node throws InvalidSetError", async () => {
    const db = new InMemoryDatabase();
    const g = buildGraph(db, [
      { output: "a", inputs: [], computor: async (_i, old) => old || { n: 0 } },
      { output: "b", inputs: ["a"], computor: async ([a]) => ({ n: a.n + 1 }) },
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
      { output: "a", inputs: [], computor: async (_i, old) => old || { n: 0 } },
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
      { output: "a", inputs: [], computor: async (_i, old) => old || { n: 0 } },
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
      { output: "a", inputs: [], computor: async (_i, old) => old || { n: 0 } },
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
      { output: "a", inputs: [], computor: async (_i, old) => old || { n: 0 } },
    ]);

    db.resetLogs();
    await g.set("a", { n: 123 });
    expect(db.batchLog.length).toBe(1);
  });
});

describe("P3: computor invoked at most once per node per top-level pull (diamond graph)", () => {
  test("diamond A -> (B,C) -> D calls each computor once", async () => {
    const db = new InMemoryDatabase();

    const bC = countedComputor("b", async ([a]) => ({ n: a.n + 1 }));
    const cC = countedComputor("c", async ([a]) => ({ n: a.n + 2 }));
    const dC = countedComputor("d", async ([b, c]) => ({ n: b.n + c.n }));

    const g = buildGraph(db, [
      { output: "a", inputs: [], computor: async (_i, old) => old || { n: 0 } },
      { output: "b", inputs: ["a"], computor: bC.computor },
      { output: "c", inputs: ["a"], computor: cC.computor },
      { output: "d", inputs: ["b", "c"], computor: dC.computor },
    ]);

    await g.set("a", { n: 10 });
    const out = await g.pull("d");
    expect(out).toEqual({ n: (10 + 1) + (10 + 2) });

    expect(bC.counter.calls).toBe(1);
    expect(cC.counter.calls).toBe(1);
    expect(dC.counter.calls).toBe(1);
  });

  test("same node required twice in inputs still must not cause double computor invocation (if implementation dedupes)", async () => {
    const db = new InMemoryDatabase();

    const bC = countedComputor("b", async ([a]) => ({ n: a.n + 1 }));
    const dC = countedComputor("d", async ([b1, b2]) => ({ n: b1.n + b2.n }));

    const g = buildGraph(db, [
      { output: "a", inputs: [], computor: async (_i, old) => old || { n: 0 } },
      { output: "b", inputs: ["a"], computor: bC.computor },
      // duplicate dependency path: inputs list literally repeats "b"
      { output: "d", inputs: ["b", "b"], computor: dC.computor },
    ]);

    await g.set("a", { n: 10 });
    const out = await g.pull("d");
    expect(out).toEqual({ n: (10 + 1) + (10 + 1) });

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
      { output: "a", inputs: [], computor: async (_i, old) => old || { n: 0 } },
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
      db.batchLog.some((b) => b.ops.some((op) => op.type === "put" && op.key === "b"));
    expect(wroteB).toBe(false);
  });

  test("Unchanged does not leak as return value (pull returns DatabaseValue, not sentinel)", async () => {
    const db = new InMemoryDatabase();
    const g = buildGraph(db, [
      {
        output: "x",
        inputs: [],
        computor: async (_i, old) => (old ? makeUnchanged() : { ok: true }),
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
      { output: "pair(a,b)", inputs: [], computor: async () => ({ ok: true }) },
    ]);

    await expect(g.pull("pair(x,42)")).rejects.toMatchObject({
      name: expect.stringMatching(/^(NonConcreteNodeError|SchemaPatternNotAllowed)$/),
    });
  });

  test("variable sharing across inputs uses same binding (full_event(e) depends on status(e), metadata(e))", async () => {
    const db = new InMemoryDatabase();

    const statusC = countedComputor("status", async (_i, _o, { e }) => ({ s: `S:${e.value}` }));
    const metaC = countedComputor("meta", async (_i, _o, { e }) => ({ m: `M:${e.value}` }));
    const fullC = countedComputor("full", async ([s, m], _o, { e }) => ({ id: e.value, s, m }));

    const g = buildGraph(db, [
      { output: "status(e)", inputs: [], computor: statusC.computor },
      { output: "metadata(e)", inputs: [], computor: metaC.computor },
      { output: "full_event(e)", inputs: ["status(e)", "metadata(e)"], computor: fullC.computor },
    ]);

    const out = await g.pull("full_event('id123')");
    expect(out.id).toBe("id123");
    expect(out.s).toEqual({ s: "S:id123" });
    expect(out.m).toEqual({ m: "M:id123" });

    // Ensure bindings passed through as e='id123'
    expect(statusC.counter.args[0].bindings.e).toEqual({ type: "string", value: "id123" });
    expect(metaC.counter.args[0].bindings.e).toEqual({ type: "string", value: "id123" });
    expect(fullC.counter.args[0].bindings.e).toEqual({ type: "string", value: "id123" });
  });

  test("schema output may contain literals (still works, only matches exact node)", async () => {
    const db = new InMemoryDatabase();
    const g = buildGraph(db, [
      { output: "special('id123')", inputs: [], computor: async () => ({ ok: true }) },
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
      { output: "all_events", inputs: [], computor: async (_i, old) => old || { events: [] } },
      { output: "event_context(e)", inputs: ["all_events"], computor: ctx1.computor },
    ]);

    await g1.set("all_events", { events: [{ id: "id123", payload: "v1" }] });
    const v1 = await g1.pull("event_context('id123')");
    expect(v1).toEqual({ id: "id123", payload: "v1" });
    expect(ctx1.counter.calls).toBe(1);

    // "Restart": new graph instance over same DB
    const ctx2 = countedComputor("ctx2", async ([all], _old, { e }) => {
      const found = all.events.find((ev) => ev.id === e.value);
      return found ? { id: found.id, payload: found.payload } : null;
    });

    const g2 = buildGraph(db, [
      { output: "all_events", inputs: [], computor: async (_i, old) => old || { events: [] } },
      { output: "event_context(e)", inputs: ["all_events"], computor: ctx2.computor },
    ]);

    await g2.set("all_events", { events: [{ id: "id123", payload: "v2" }] });
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
      { output: "leaf", inputs: [], computor: async (_i, old) => old || { ok: true } },
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
      { output: "a", inputs: [], computor: async (_i, old) => old || { n: 0 } },
      { output: "b", inputs: ["a"], computor: async ([a]) => ({ n: a.n + 1 }) },
    ]);

    if (typeof g.debugGetFreshness !== "function" || typeof g.debugListMaterializedNodes !== "function") {
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
      { output: "status(e,'active')", inputs: [], computor: async (_i, old) => old || { ok: true } },
    ]);

    db.resetLogs();
    await g.set("status( 'e1' , 'active' )", { ok: 123 });

    const canonicalKey = "status('e1','active')";
    const wroteCanonical =
      db.batchLog.some((b) => b.ops.some((op) => op.type === "put" && op.key.includes(canonicalKey))) ||
      db.putLog.some((p) => p.key.includes(canonicalKey));

    expect(wroteCanonical).toBe(true);
  });

  test("pull reads the canonical key (observed via getValue calls) when input has whitespace", async () => {
    const db = new InMemoryDatabase();
    const g = buildGraph(db, [
      { output: "status(e,'active')", inputs: [], computor: async (_i, old) => old || { ok: true } },
    ]);

    await g.set("status('e1','active')", { ok: 1 });

    db.resetLogs();
    await g.pull("status( 'e1' , 'active' )");

    const canonicalKey = "status('e1','active')";
    const readCanonical = db.getValueLog.some((x) => x.key.includes(canonicalKey));
    expect(readCanonical).toBe(true);
  });
});
