/**
 * Tests for MigrationStorage - strict migration decision API for incremental graph.
 */

const { makeMigrationStorage } = require("../src/generators/incremental_graph/migration_storage");
const { compileNodeDef } = require("../src/generators/incremental_graph/compiled_node");
const {
    isDecisionConflict,
    isOverrideConflict,
    isUndecidedNodes,
    isPartialDeleteFanIn,
    isSchemaCompatibility,
    isGetMissingNode,
    isGetMissingValue,
    isMissingDependencyMetadata,
    isCreateExistingNode,
} = require("../src/generators/incremental_graph/migration_errors");
const { toJsonKey } = require("./test_json_key_helper");

// ---------------------------------------------------------------------------
// In-memory mock SchemaStorage (avoids LevelDB for unit tests)
// ---------------------------------------------------------------------------

function makeInMemoryDb() {
    const store = new Map();
    return {
        async get(key) { return store.get(key); },
        async put(key, value) { store.set(key, value); },
        async del(key) { store.delete(key); },
        putOp(key, value) { return { type: "put", sublevel: null, key, value }; },
        delOp(key) { return { type: "del", sublevel: null, key }; },
        async *keys() { for (const k of store.keys()) yield k; },
        async clear() { store.clear(); },
    };
}

function makeInMemorySchemaStorage() {
    return {
        values: makeInMemoryDb(),
        freshness: makeInMemoryDb(),
        inputs: makeInMemoryDb(),
        revdeps: makeInMemoryDb(),
        counters: makeInMemoryDb(),
        async batch(_ops) {},
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** NodeKeyString for a zero-arity node named `name`. */
const nk = (name) => toJsonKey(name);

const DUMMY_VALUE = { type: "all_events", events: [] };
const DUMMY_VALUE_2 = { type: "meta_events", meta_events: [] };

/**
 * Build a compiled head index from a list of zero-arity node names.
 */
function makeHeadIndex(nodeNames) {
    const headIndex = new Map();
    for (const name of nodeNames) {
        const compiled = compileNodeDef({
            output: name,
            inputs: [],
            computor: async () => DUMMY_VALUE,
            isDeterministic: true,
            hasSideEffects: false,
            migrations: {},
        });
        headIndex.set(compiled.head, compiled);
    }
    return headIndex;
}

/**
 * Populate the standard test graph into `storage` and return a MigrationStorage.
 *
 * Graph topology:
 *   A (source) → B → D
 *   C (source) ─────→ D
 *
 * D = f(B, C), B = g(A), A and C are sources.
 *
 * @param {ReturnType<typeof makeInMemorySchemaStorage>} storage
 * @param {Map<*, *>} newHeadIndex
 * @param {{ noValueForD?: boolean }} [opts]
 */
async function setupStandardGraph(storage, newHeadIndex, opts = {}) {
    const A = nk("A"), B = nk("B"), C = nk("C"), D = nk("D");

    await storage.values.put(A, DUMMY_VALUE);
    await storage.values.put(B, DUMMY_VALUE);
    await storage.values.put(C, DUMMY_VALUE);
    if (!opts.noValueForD) {
        await storage.values.put(D, DUMMY_VALUE);
    }

    // inputs records (inputs stored as plain strings = NodeKeyStrings at runtime)
    await storage.inputs.put(A, { inputs: [], inputCounters: [] });
    await storage.inputs.put(B, { inputs: [A], inputCounters: [1] });
    await storage.inputs.put(C, { inputs: [], inputCounters: [] });
    await storage.inputs.put(D, { inputs: [B, C], inputCounters: [1, 1] });

    // revdeps
    await storage.revdeps.put(A, [B]);
    await storage.revdeps.put(B, [D]);
    await storage.revdeps.put(C, [D]);

    return makeMigrationStorage(storage, newHeadIndex, [A, B, C, D]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MigrationStorage", () => {
    // -----------------------------------------------------------------------
    // Section 1: Decision idempotency & conflicts
    // -----------------------------------------------------------------------
    describe("Section 1: Decision idempotency & conflicts", () => {
        test("keep(A) twice succeeds (idempotent)", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A"]);
            const A = nk("A");
            await storage.inputs.put(A, { inputs: [], inputCounters: [] });
            const ms = makeMigrationStorage(storage, headIndex, [A]);

            await ms.keep(A);
            await expect(ms.keep(A)).resolves.toBeUndefined();
        });

        test("invalidate(A) twice succeeds (idempotent)", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A"]);
            const A = nk("A");
            await storage.inputs.put(A, { inputs: [], inputCounters: [] });
            const ms = makeMigrationStorage(storage, headIndex, [A]);

            await ms.invalidate(A);
            await expect(ms.invalidate(A)).resolves.toBeUndefined();
        });

        test("delete(A) twice succeeds (idempotent)", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A"]);
            const A = nk("A");
            await storage.inputs.put(A, { inputs: [], inputCounters: [] });
            const ms = makeMigrationStorage(storage, headIndex, [A]);

            await ms.delete(A);
            await expect(ms.delete(A)).resolves.toBeUndefined();
        });

        test("override(A, v) twice with same value fails", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A"]);
            const A = nk("A");
            await storage.inputs.put(A, { inputs: [], inputCounters: [] });
            const ms = makeMigrationStorage(storage, headIndex, [A]);

            await ms.override(A, Promise.resolve(DUMMY_VALUE));
            const err = await ms.override(A, Promise.resolve(DUMMY_VALUE)).catch((e) => e);
            expect(isOverrideConflict(err)).toBe(true);
        });

        test("override(A, v1) then override(A, v2) throws OverrideConflictError", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A"]);
            const A = nk("A");
            await storage.inputs.put(A, { inputs: [], inputCounters: [] });
            const ms = makeMigrationStorage(storage, headIndex, [A]);

            await ms.override(A, Promise.resolve(DUMMY_VALUE));
            const err = await ms.override(A, Promise.resolve(DUMMY_VALUE_2)).catch((e) => e);
            expect(isOverrideConflict(err)).toBe(true);
        });

        test("keep(A) then invalidate(A) throws DecisionConflictError", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A"]);
            const A = nk("A");
            await storage.inputs.put(A, { inputs: [], inputCounters: [] });
            const ms = makeMigrationStorage(storage, headIndex, [A]);

            await ms.keep(A);
            const err = await ms.invalidate(A).catch((e) => e);
            expect(isDecisionConflict(err)).toBe(true);
        });

        test("invalidate(A) then keep(A) throws DecisionConflictError", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A"]);
            const A = nk("A");
            await storage.inputs.put(A, { inputs: [], inputCounters: [] });
            const ms = makeMigrationStorage(storage, headIndex, [A]);

            await ms.invalidate(A);
            const err = await ms.keep(A).catch((e) => e);
            expect(isDecisionConflict(err)).toBe(true);
        });

        test("keep(D) then override(A) causes propagation conflict", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A", "B", "C", "D"]);
            const ms = await setupStandardGraph(storage, headIndex);

            await ms.keep(nk("D"));
            // override(A) propagates INVALIDATE to B and D → D has KEEP → conflict
            const err = await ms.override(nk("A"), Promise.resolve(DUMMY_VALUE)).catch((e) => e);
            expect(isDecisionConflict(err)).toBe(true);
        });
    });

    // -----------------------------------------------------------------------
    // Section 2: get() correctness
    // -----------------------------------------------------------------------
    describe("Section 2: get() correctness", () => {
        test("get(nonMaterialized) throws GetMissingNodeError", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A"]);
            const A = nk("A"), B = nk("B");
            await storage.inputs.put(A, { inputs: [], inputCounters: [] });
            const ms = makeMigrationStorage(storage, headIndex, [A]);

            const err = await ms.get(B).catch((e) => e);
            expect(isGetMissingNode(err)).toBe(true);
        });

        test("get(materializedWithoutValue) throws GetMissingValueError", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A"]);
            const A = nk("A");
            // Write inputs record but no value
            await storage.inputs.put(A, { inputs: [], inputCounters: [] });
            const ms = makeMigrationStorage(storage, headIndex, [A]);

            const err = await ms.get(A).catch((e) => e);
            expect(isGetMissingValue(err)).toBe(true);
        });

        test("get(materializedWithValue) returns old value", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A"]);
            const A = nk("A");
            await storage.inputs.put(A, { inputs: [], inputCounters: [] });
            await storage.values.put(A, DUMMY_VALUE);
            const ms = makeMigrationStorage(storage, headIndex, [A]);

            const result = await ms.get(A);
            expect(result).toEqual(DUMMY_VALUE);
        });

        test("get() returns old value even after override()", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A"]);
            const A = nk("A");
            await storage.inputs.put(A, { inputs: [], inputCounters: [] });
            await storage.values.put(A, DUMMY_VALUE);
            const ms = makeMigrationStorage(storage, headIndex, [A]);

            await ms.override(A, Promise.resolve(DUMMY_VALUE_2));
            const result = await ms.get(A);
            expect(result).toEqual(DUMMY_VALUE); // still old value
        });
    });

    // -----------------------------------------------------------------------
    // Section 3: INVALIDATE propagation (fan-in allowed)
    // -----------------------------------------------------------------------
    describe("Section 3: INVALIDATE propagation", () => {
        test("invalidate(A) propagates to B and D", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A", "B", "C", "D"]);
            const ms = await setupStandardGraph(storage, headIndex);

            await ms.invalidate(nk("A"));

            // Must keep/delete remaining nodes to satisfy completeness
            await ms.keep(nk("C"));
            const decisions = await ms.finalize();

            expect(decisions.get(nk("A"))?.kind).toBe("invalidate");
            expect(decisions.get(nk("B"))?.kind).toBe("invalidate");
            expect(decisions.get(nk("D"))?.kind).toBe("invalidate");
        });

        test("invalidate(A) propagates through B to D (multi-hop)", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A", "B", "C", "D"]);
            const ms = await setupStandardGraph(storage, headIndex);

            // Invalidate only A; D is a fan-in of B and C, allowed
            await ms.invalidate(nk("A"));
            await ms.keep(nk("C"));
            const decisions = await ms.finalize();

            expect(decisions.get(nk("D"))?.kind).toBe("invalidate");
        });
    });

    // -----------------------------------------------------------------------
    // Section 4: OVERRIDE propagation
    // -----------------------------------------------------------------------
    describe("Section 4: OVERRIDE propagation", () => {
        test("override(A) invalidates B and D", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A", "B", "C", "D"]);
            const ms = await setupStandardGraph(storage, headIndex);

            await ms.override(nk("A"), Promise.resolve(DUMMY_VALUE_2));
            await ms.keep(nk("C"));
            const decisions = await ms.finalize();

            expect(decisions.get(nk("B"))?.kind).toBe("invalidate");
            expect(decisions.get(nk("D"))?.kind).toBe("invalidate");
        });

        test("keep(D) then override(A) throws DecisionConflictError via propagation", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A", "B", "C", "D"]);
            const ms = await setupStandardGraph(storage, headIndex);

            await ms.keep(nk("D"));
            const err = await ms.override(nk("A"), Promise.resolve(DUMMY_VALUE_2)).catch((e) => e);
            expect(isDecisionConflict(err)).toBe(true);
        });
    });

    // -----------------------------------------------------------------------
    // Section 5: DELETE propagation + fan-in restriction
    // -----------------------------------------------------------------------
    describe("Section 5: DELETE propagation + fan-in restriction", () => {
        test("delete(B) alone throws PartialDeleteFanInError (C not deleted)", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A", "B", "C", "D"]);
            const ms = await setupStandardGraph(storage, headIndex);

            await ms.keep(nk("A"));
            await ms.delete(nk("B"));
            await ms.keep(nk("C"));
            // D is undecided; during finalize, B is deleted but C is not → PartialDeleteFanInError
            const err = await ms.finalize().catch((e) => e);
            expect(isPartialDeleteFanIn(err)).toBe(true);
        });

        test("delete(B) and delete(C) results in D auto-deleted", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A", "B", "C", "D"]);
            const ms = await setupStandardGraph(storage, headIndex);

            await ms.keep(nk("A"));
            await ms.delete(nk("B"));
            await ms.delete(nk("C"));
            const decisions = await ms.finalize();

            expect(decisions.get(nk("D"))?.kind).toBe("delete");
        });

        test("delete(C) then delete(B) also results in D deleted (order independent)", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A", "B", "C", "D"]);
            const ms = await setupStandardGraph(storage, headIndex);

            await ms.keep(nk("A"));
            await ms.delete(nk("C"));
            await ms.delete(nk("B"));
            const decisions = await ms.finalize();

            expect(decisions.get(nk("D"))?.kind).toBe("delete");
        });

        test("delete(A) propagates to B, then tries D: PartialDeleteFanInError (C not deleted)", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A", "B", "C", "D"]);
            const ms = await setupStandardGraph(storage, headIndex);

            await ms.delete(nk("A"));
            await ms.keep(nk("C"));
            const err = await ms.finalize().catch((e) => e);
            expect(isPartialDeleteFanIn(err)).toBe(true);
        });

        test("keep(D) conflicts with delete auto-propagation", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A", "B", "C", "D"]);
            const ms = await setupStandardGraph(storage, headIndex);

            await ms.keep(nk("A"));
            await ms.keep(nk("D"));
            await ms.delete(nk("B"));
            await ms.delete(nk("C"));
            // finalize tries to delete D (all inputs deleted) but D is KEEP → conflict
            const err = await ms.finalize().catch((e) => e);
            expect(isDecisionConflict(err)).toBe(true);
        });
    });

    // -----------------------------------------------------------------------
    // Section 6: Completeness check
    // -----------------------------------------------------------------------
    describe("Section 6: Completeness check", () => {
        test("undecided nodes throw UndecidedNodesError", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A", "B", "C", "D"]);
            const ms = await setupStandardGraph(storage, headIndex);

            // Only decide A; leave B, C, D undecided
            await ms.keep(nk("A"));
            const err = await ms.finalize().catch((e) => e);
            expect(isUndecidedNodes(err)).toBe(true);
        });

        test("all nodes decided: finalize succeeds", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A", "B", "C", "D"]);
            const ms = await setupStandardGraph(storage, headIndex);

            await ms.keep(nk("A"));
            await ms.keep(nk("B"));
            await ms.keep(nk("C"));
            await ms.keep(nk("D"));
            await expect(ms.finalize()).resolves.toBeDefined();
        });
    });

    // -----------------------------------------------------------------------
    // Section 7: Traversal methods
    // -----------------------------------------------------------------------
    describe("Section 7: Traversal methods", () => {
        test("listMaterializedNodes() returns exactly S", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A", "B", "C", "D"]);
            const ms = await setupStandardGraph(storage, headIndex);

            const nodes = [];
            for await (const n of ms.listMaterializedNodes()) {
                nodes.push(n);
            }
            const expected = [nk("A"), nk("B"), nk("C"), nk("D")];
            expect(nodes.sort()).toEqual(expected.sort());
        });

        test("has() returns true for materialized nodes", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A"]);
            const A = nk("A");
            await storage.inputs.put(A, { inputs: [], inputCounters: [] });
            const ms = makeMigrationStorage(storage, headIndex, [A]);

            expect(await ms.has(A)).toBe(true);
            expect(await ms.has(nk("Z"))).toBe(false);
        });

        test("getInputs(D) returns [B, C]", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A", "B", "C", "D"]);
            const ms = await setupStandardGraph(storage, headIndex);

            const inputs = await ms.getInputs(nk("D"));
            expect([...inputs].sort()).toEqual([nk("B"), nk("C")].sort());
        });

        test("getInputs(A) returns [] (source node)", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A", "B", "C", "D"]);
            const ms = await setupStandardGraph(storage, headIndex);

            const inputs = await ms.getInputs(nk("A"));
            expect(inputs).toEqual([]);
        });

        test("getDependents(A) returns [B]", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A", "B", "C", "D"]);
            const ms = await setupStandardGraph(storage, headIndex);

            const deps = await ms.getDependents(nk("A"));
            expect(deps).toEqual([nk("B")]);
        });

        test("getDependents(D) returns [] (leaf)", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A", "B", "C", "D"]);
            const ms = await setupStandardGraph(storage, headIndex);

            const deps = await ms.getDependents(nk("D"));
            expect(deps).toEqual([]);
        });

        test("getInputs(nonMaterialized) throws GetMissingNodeError", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A"]);
            const A = nk("A");
            await storage.inputs.put(A, { inputs: [], inputCounters: [] });
            const ms = makeMigrationStorage(storage, headIndex, [A]);

            const err = await ms.getInputs(nk("Z")).catch((e) => e);
            expect(isGetMissingNode(err)).toBe(true);
        });

        test("getInputs(node) throws MissingDependencyMetadataError if record missing", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A"]);
            const A = nk("A");
            // materializedNodes contains A but no inputs record written → corrupt state
            const ms = makeMigrationStorage(storage, headIndex, [A]);

            const err = await ms.getInputs(A).catch((e) => e);
            expect(isMissingDependencyMetadata(err)).toBe(true);
        });
    });

    // -----------------------------------------------------------------------
    // Section 8: Schema compatibility checks
    // -----------------------------------------------------------------------
    describe("Section 8: Schema compatibility checks", () => {
        test("keep() on incompatible node throws SchemaCompatibilityError", async () => {
            const storage = makeInMemorySchemaStorage();
            // New schema has only B, C, D — not A
            const headIndex = makeHeadIndex(["B", "C", "D"]);
            const ms = await setupStandardGraph(storage, headIndex);

            const err = await ms.keep(nk("A")).catch((e) => e);
            expect(isSchemaCompatibility(err)).toBe(true);
        });

        test("invalidate() on incompatible node throws SchemaCompatibilityError", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["B", "C", "D"]);
            const ms = await setupStandardGraph(storage, headIndex);

            const err = await ms.invalidate(nk("A")).catch((e) => e);
            expect(isSchemaCompatibility(err)).toBe(true);
        });

        test("override() on incompatible node throws SchemaCompatibilityError", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["B", "C", "D"]);
            const ms = await setupStandardGraph(storage, headIndex);

            const err = await ms.override(nk("A"), Promise.resolve(DUMMY_VALUE)).catch((e) => e);
            expect(isSchemaCompatibility(err)).toBe(true);
        });

        test("delete() on incompatible node succeeds (no schema check)", async () => {
            const storage = makeInMemorySchemaStorage();
            // New schema has only C, D — not A or B
            const headIndex = makeHeadIndex(["C", "D"]);
            const ms = await setupStandardGraph(storage, headIndex);

            // delete(A) is always allowed regardless of schema
            await expect(ms.delete(nk("A"))).resolves.toBeUndefined();
        });

        test("propagated invalidation on incompatible dependent throws SchemaCompatibilityError", async () => {
            const storage = makeInMemorySchemaStorage();
            // B is not in new schema; A is; C and D are
            const headIndex = makeHeadIndex(["A", "C", "D"]);
            const ms = await setupStandardGraph(storage, headIndex);

            // invalidate(A) will try to propagate to B which is incompatible → SchemaCompatibilityError
            const err = await ms.invalidate(nk("A")).catch((e) => e);
            expect(isSchemaCompatibility(err)).toBe(true);
        });
    });

    // -----------------------------------------------------------------------
    // Section 9: create() method
    // -----------------------------------------------------------------------
    describe("Section 9: create() method", () => {
        test("create(newNode, value) on a node not in S succeeds", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A", "NEW"]);
            const A = nk("A");
            await storage.inputs.put(A, { inputs: [], inputCounters: [] });
            const ms = makeMigrationStorage(storage, headIndex, [A]);

            await ms.keep(A);
            await expect(ms.create(nk("NEW"), Promise.resolve(DUMMY_VALUE))).resolves.toBeUndefined();
        });

        test("create(existingNode) throws CreateExistingNodeError", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A"]);
            const A = nk("A");
            await storage.inputs.put(A, { inputs: [], inputCounters: [] });
            const ms = makeMigrationStorage(storage, headIndex, [A]);

            const err = await ms.create(A, Promise.resolve(DUMMY_VALUE)).catch((e) => e);
            expect(isCreateExistingNode(err)).toBe(true);
        });

        test("create() on a node not in new schema throws SchemaCompatibilityError", async () => {
            const storage = makeInMemorySchemaStorage();
            // New schema has only A — not NEW
            const headIndex = makeHeadIndex(["A"]);
            const A = nk("A");
            await storage.inputs.put(A, { inputs: [], inputCounters: [] });
            const ms = makeMigrationStorage(storage, headIndex, [A]);

            await ms.keep(A);
            const err = await ms.create(nk("NEW"), Promise.resolve(DUMMY_VALUE)).catch((e) => e);
            expect(isSchemaCompatibility(err)).toBe(true);
        });

        test("create() twice on same node throws DecisionConflictError", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A", "NEW"]);
            const A = nk("A");
            await storage.inputs.put(A, { inputs: [], inputCounters: [] });
            const ms = makeMigrationStorage(storage, headIndex, [A]);

            await ms.keep(A);
            await ms.create(nk("NEW"), Promise.resolve(DUMMY_VALUE));
            const err = await ms.create(nk("NEW"), Promise.resolve(DUMMY_VALUE_2)).catch((e) => e);
            expect(isDecisionConflict(err)).toBe(true);
        });

        test("create() decision appears in finalize() result", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A", "NEW"]);
            const A = nk("A");
            await storage.inputs.put(A, { inputs: [], inputCounters: [] });
            await storage.values.put(A, DUMMY_VALUE);
            const ms = makeMigrationStorage(storage, headIndex, [A]);

            await ms.keep(A);
            await ms.create(nk("NEW"), Promise.resolve(DUMMY_VALUE_2));
            const decisions = await ms.finalize();

            const createDecision = decisions.get(nk("NEW"));
            expect(createDecision?.kind).toBe("create");
            expect(await createDecision?.value).toEqual(DUMMY_VALUE_2);
        });

        test("create() does not affect completeness check (S nodes still need decisions)", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A", "NEW"]);
            const A = nk("A");
            await storage.inputs.put(A, { inputs: [], inputCounters: [] });
            const ms = makeMigrationStorage(storage, headIndex, [A]);

            // Only create a new node, don't decide A
            await ms.create(nk("NEW"), Promise.resolve(DUMMY_VALUE));
            const err = await ms.finalize().catch((e) => e);
            expect(isUndecidedNodes(err)).toBe(true);
        });

        test("create() accepts a pending promise (value is not awaited during planning)", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A", "NEW"]);
            const A = nk("A");
            await storage.inputs.put(A, { inputs: [], inputCounters: [] });
            const ms = makeMigrationStorage(storage, headIndex, [A]);

            await ms.keep(A);
            // Pass a promise that never resolves; create() should return immediately
            const neverResolves = new Promise(() => {});
            await expect(ms.create(nk("NEW"), neverResolves)).resolves.toBeUndefined();
        });
    });

    // -----------------------------------------------------------------------
    // Section 10: override() accepts promise
    // -----------------------------------------------------------------------
    describe("Section 10: override() accepts promise", () => {
        test("override() accepts a pending promise (value is not awaited during planning)", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A"]);
            const A = nk("A");
            await storage.inputs.put(A, { inputs: [], inputCounters: [] });
            const ms = makeMigrationStorage(storage, headIndex, [A]);

            // Pass a promise that never resolves; override() should return immediately
            const neverResolves = new Promise(() => {});
            await expect(ms.override(A, neverResolves)).resolves.toBeUndefined();
        });
    });
});
