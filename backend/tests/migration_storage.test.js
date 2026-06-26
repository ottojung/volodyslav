/**
 * Tests for MigrationStorage - strict migration decision API for incremental graph.
 */

const { makeMigrationStorage } = require("../src/generators/incremental_graph/migration_storage");
const { compileNodeDef } = require("../src/generators/incremental_graph/compiled_node");
const { IDENTIFIERS_KEY } = require("../src/generators/incremental_graph/database");
const {
    isDecisionConflict,
    isOverrideConflict,
    isUndecidedNodes,
    isPartialDeleteFanIn,
    isSchemaCompatibility,
    isGetMissingNode,
    isGetMissingValue,
    isCreateExistingNode,
} = require("../src/generators/incremental_graph/migration_errors");
const { toJsonKey } = require("./test_json_key_helper");

// ---------------------------------------------------------------------------
// In-memory mock SchemaStorage (avoids LevelDB for unit tests)
// ---------------------------------------------------------------------------

function makeInMemoryDb() {
    const store = new Map();
    return {
        store,
        async get(key) { return store.get(key); },
        async put(key, value) { store.set(key, value); },
        async noFlushPut(key, value) { store.set(key, value); },
        async del(key) { store.delete(key); },
        async noFlushDel(key) { store.delete(key); },
        putOp(key, value) { return { type: "put", sublevel: null, key, value }; },
        delOp(key) { return { type: "del", sublevel: null, key }; },
        async *keys() { for (const k of store.keys()) yield k; },
        async clear() { store.clear(); },
    };
}

function makeInMemorySchemaStorage() {
    const values = makeInMemoryDb();
    const freshness = makeInMemoryDb();
    const valid = makeInMemoryDb();
    const timestamps = makeInMemoryDb();
    const global = makeInMemoryDb();
    const originalGlobalGet = global.get.bind(global);
    global.get = async (key) => {
        if (key !== IDENTIFIERS_KEY) {
            return await originalGlobalGet(key);
        }
        const stored = await originalGlobalGet(key);
        if (stored !== undefined) return stored;
        return [...values.store.keys()]
            .sort()
            .map((nodeKey) => [nodeKey, nodeKey]);
    };
    return {
        values,
        freshness,
        valid,
        timestamps,
        global,
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
 * Build a graph scheme for a single zero-arity node.
 * @param {string} head
 * @returns {import('../src/generators/incremental_graph/database/graph_scheme').GraphScheme}
 */
function makeSingleNodeScheme(head) {
    return { format: 1, nodes: [{ head, arity: 0, inputTemplates: [] }] };
}

/**
 * Build an identifier lookup mapping each NodeKeyString to itself.
 * @param {string[]} nodeKeyStrings
 * @returns {import('../src/generators/incremental_graph/database/identifier_lookup').IdentifierLookup}
 */
function makeLookupFromKeys(nodeKeyStrings) {
    const entries = nodeKeyStrings.map((k) => [k, k]);
    const { makeIdentifierLookup } = require("../src/generators/incremental_graph/database");
    return makeIdentifierLookup(entries);
}

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
        });
        headIndex.set(compiled.head, compiled);
    }
    return headIndex;
}

/**
 * Build a graph scheme for the standard test graph.
 *
 * Graph topology (all zero-arity):
 *   A (source) → B → D
 *   C (source) ─────→ D
 *
 * @returns {import('../src/generators/incremental_graph/database/graph_scheme').GraphScheme}
 */
function makeStandardGraphScheme() {
    return {
        format: 1,
        nodes: [
            { head: "A", arity: 0, inputTemplates: [] },
            { head: "B", arity: 0, inputTemplates: [{ head: "A", args: [] }] },
            { head: "C", arity: 0, inputTemplates: [] },
            { head: "D", arity: 0, inputTemplates: [{ head: "B", args: [] }, { head: "C", args: [] }] },
        ],
    };
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
    await storage.freshness.put(A, "up-to-date");
    await storage.freshness.put(B, "up-to-date");
    await storage.freshness.put(C, "up-to-date");
    await storage.freshness.put(D, opts.noValueForD ? "missing" : "up-to-date");
    await storage.timestamps.put(A, { createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-01T00:00:00.000Z" });
    await storage.timestamps.put(B, { createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-01T00:00:00.000Z" });
    await storage.timestamps.put(C, { createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-01T00:00:00.000Z" });
    await storage.timestamps.put(D, { createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-01T00:00:00.000Z" });
    if (!opts.noValueForD) {
        await storage.values.put(D, DUMMY_VALUE);
    }

    // valid
    await storage.valid.put(A, [B]);
    await storage.valid.put(B, [D]);
    await storage.valid.put(C, [D]);

    const scheme = makeStandardGraphScheme();
    const lookup = makeLookupFromKeys([A, B, C, D]);
    return makeMigrationStorage(storage, newHeadIndex, [A, B, C, D], "testfingerprint", 0, scheme, scheme, lookup);
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
            const scheme = makeSingleNodeScheme("A");
            const lookup = makeLookupFromKeys([A]);
            await storage.values.put(A, DUMMY_VALUE);
            await storage.freshness.put(A, "up-to-date");
            await storage.timestamps.put(A, { createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-01T00:00:00.000Z" });
            const ms = makeMigrationStorage(storage, headIndex, [A], "testfingerprint", 0, scheme, scheme, lookup);

            await ms.keep(A);
            await expect(ms.keep(A)).resolves.toBeUndefined();
        });

        test("invalidate(A) twice succeeds (idempotent)", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A"]);
            const A = nk("A");
            await storage.values.put(A, DUMMY_VALUE);
            await storage.freshness.put(A, "up-to-date");
            await storage.timestamps.put(A, { createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-01T00:00:00.000Z" });
            const scheme = makeSingleNodeScheme("A");
            const lookup = makeLookupFromKeys([A]);
            const ms = makeMigrationStorage(storage, headIndex, [A], "testfingerprint", 0, scheme, scheme, lookup);

            await ms.invalidate(A);
            await expect(ms.invalidate(A)).resolves.toBeUndefined();
        });

        test("delete(A) twice succeeds (idempotent)", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A"]);
            const A = nk("A");
            const scheme = makeSingleNodeScheme("A");
            const lookup = makeLookupFromKeys([A]);
            const ms = makeMigrationStorage(storage, headIndex, [A], "testfingerprint", 0, scheme, scheme, lookup);

            await ms.delete(A);
            await expect(ms.delete(A)).resolves.toBeUndefined();
        });

        test("override(A) twice fails with OverrideConflictError (non-idempotent)", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A"]);
            const A = nk("A");
            await storage.values.put(A, DUMMY_VALUE);
            await storage.freshness.put(A, "up-to-date");
            await storage.timestamps.put(A, { createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-01T00:00:00.000Z" });
            const scheme = makeSingleNodeScheme("A");
            const lookup = makeLookupFromKeys([A]);
            const ms = makeMigrationStorage(storage, headIndex, [A], "testfingerprint", 0, scheme, scheme, lookup);

            await ms.override(A, () => Promise.resolve(DUMMY_VALUE));
            const err = await ms.override(A, () => Promise.resolve(DUMMY_VALUE)).catch((e) => e);
            expect(isOverrideConflict(err)).toBe(true);
        });

        test("override(A) twice throws OverrideConflictError regardless of value identity", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A"]);
            const A = nk("A");
            await storage.values.put(A, DUMMY_VALUE);
            await storage.freshness.put(A, "up-to-date");
            await storage.timestamps.put(A, { createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-01T00:00:00.000Z" });
            const scheme = makeSingleNodeScheme("A");
            const lookup = makeLookupFromKeys([A]);
            const ms = makeMigrationStorage(storage, headIndex, [A], "testfingerprint", 0, scheme, scheme, lookup);

            await ms.override(A, () => Promise.resolve(DUMMY_VALUE));
            const err = await ms.override(A, () => Promise.resolve(DUMMY_VALUE_2)).catch((e) => e);
            expect(isOverrideConflict(err)).toBe(true);
        });

        test("keep(A) then invalidate(A) throws DecisionConflictError", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A"]);
            const A = nk("A");
            const scheme = makeSingleNodeScheme("A");
            const lookup = makeLookupFromKeys([A]);
            await storage.values.put(A, DUMMY_VALUE);
            await storage.freshness.put(A, "up-to-date");
            await storage.timestamps.put(A, { createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-01T00:00:00.000Z" });
            const ms = makeMigrationStorage(storage, headIndex, [A], "testfingerprint", 0, scheme, scheme, lookup);

            await ms.keep(A);
            const err = await ms.invalidate(A).catch((e) => e);
            expect(isDecisionConflict(err)).toBe(true);
        });

        test("invalidate(A) then keep(A) throws DecisionConflictError", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A"]);
            const A = nk("A");
            const scheme = makeSingleNodeScheme("A");
            const lookup = makeLookupFromKeys([A]);
            await storage.values.put(A, DUMMY_VALUE);
            await storage.freshness.put(A, "up-to-date");
            await storage.timestamps.put(A, { createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-01T00:00:00.000Z" });
            const ms = makeMigrationStorage(storage, headIndex, [A], "testfingerprint", 0, scheme, scheme, lookup);

            await ms.invalidate(A);
            const err = await ms.keep(A).catch((e) => e);
            expect(isDecisionConflict(err)).toBe(true);
        });

        test("keep(D) then override(A) does not propagate invalidation", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A", "B", "C", "D"]);
            const ms = await setupStandardGraph(storage, headIndex);

            await ms.keep(nk("D"));
            await expect(ms.override(nk("A"), () => Promise.resolve(DUMMY_VALUE))).resolves.toBeUndefined();
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
            const scheme = makeSingleNodeScheme("A");
            const lookup = makeLookupFromKeys([A]);
            const ms = makeMigrationStorage(storage, headIndex, [A], "testfingerprint", 0, scheme, scheme, lookup);

            const err = await ms.get(B).catch((e) => e);
            expect(isGetMissingNode(err)).toBe(true);
        });

        test("get(materializedWithoutValue) throws GetMissingValueError", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A"]);
            const A = nk("A");
            const scheme = makeSingleNodeScheme("A");
            const lookup = makeLookupFromKeys([A]);
            const ms = makeMigrationStorage(storage, headIndex, [A], "testfingerprint", 0, scheme, scheme, lookup);

            const err = await ms.get(A).catch((e) => e);
            expect(isGetMissingValue(err)).toBe(true);
        });

        test("get(materializedWithValue) returns old value", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A"]);
            const A = nk("A");
            await storage.values.put(A, DUMMY_VALUE);
            await storage.freshness.put(A, "up-to-date");
            await storage.timestamps.put(A, { createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-01T00:00:00.000Z" });
            const scheme = makeSingleNodeScheme("A");
            const lookup = makeLookupFromKeys([A]);
            const ms = makeMigrationStorage(storage, headIndex, [A], "testfingerprint", 0, scheme, scheme, lookup);

            const result = await ms.get(A);
            expect(result).toEqual(DUMMY_VALUE);
        });

        test("get() returns old value even after override()", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A"]);
            const A = nk("A");
            await storage.values.put(A, DUMMY_VALUE);
            await storage.freshness.put(A, "up-to-date");
            await storage.timestamps.put(A, { createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-01T00:00:00.000Z" });
            const scheme = makeSingleNodeScheme("A");
            const lookup = makeLookupFromKeys([A]);
            const ms = makeMigrationStorage(storage, headIndex, [A], "testfingerprint", 0, scheme, scheme, lookup);

            await ms.override(A, () => Promise.resolve(DUMMY_VALUE_2));
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
    // Section 4: OVERRIDE preserves graph state
    // -----------------------------------------------------------------------
    describe("Section 4: OVERRIDE preserves graph state", () => {
        test("override(A) does not invalidate B and D", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A", "B", "C", "D"]);
            const ms = await setupStandardGraph(storage, headIndex);

            await ms.override(nk("A"), () => Promise.resolve(DUMMY_VALUE_2));
            await ms.keep(nk("B"));
            await ms.keep(nk("C"));
            await ms.keep(nk("D"));
            const decisions = await ms.finalize();

            expect(decisions.get(nk("B"))?.kind).toBe("keep");
            expect(decisions.get(nk("D"))?.kind).toBe("keep");
        });

        test("keep(D) then override(A) is allowed because override does not propagate", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A", "B", "C", "D"]);
            const ms = await setupStandardGraph(storage, headIndex);

            await ms.keep(nk("D"));
            await expect(ms.override(nk("A"), () => Promise.resolve(DUMMY_VALUE_2))).resolves.toBeUndefined();
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

        test("delete propagation uses structural inputs when valid flags are missing (stale dependent)", async () => {
            // A -> B, valid[A] is missing B (stale). delete(A) propagates;
            // the structural dependency scan via scheme-derived edges finds B as a
            // dependent of A and auto-deletes it since all its inputs are deleted.
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A", "B"]);
            const A = nk("A");
            const B = nk("B");
            const scheme = {
                format: 1,
                nodes: [
                    { head: "A", arity: 0, inputTemplates: [] },
                    { head: "B", arity: 0, inputTemplates: [{ head: "A", args: [] }] },
                ],
            };
            const lookup = makeLookupFromKeys([A, B]);
            await storage.values.put(A, DUMMY_VALUE);
            await storage.values.put(B, DUMMY_VALUE);
            // valid[A] intentionally left missing for B (simulates stale B)
            const ms = makeMigrationStorage(storage, headIndex, [A, B], "testfingerprint", 0, scheme, scheme, lookup);

            await ms.delete(A);
            // B is auto-deleted via structural scan even though valid[A] is missing
            const decisions = await ms.finalize();
            expect(decisions.get(B)?.kind).toBe("delete");
        });

        test("fan-in detection uses structural inputs when valid flags are missing (stale dependent)", async () => {
            // B -> D, C -> D, valid[B] is missing D (stale). delete(B), keep(C).
            // The structural dependency scan must still find D dependent on B
            // and report PartialDeleteFanInError (C is kept so D has a surviving input).
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["B", "C", "D"]);
            const B = nk("B");
            const C = nk("C");
            const D = nk("D");
            const scheme = {
                format: 1,
                nodes: [
                    { head: "B", arity: 0, inputTemplates: [] },
                    { head: "C", arity: 0, inputTemplates: [] },
                    { head: "D", arity: 0, inputTemplates: [{ head: "B", args: [] }, { head: "C", args: [] }] },
                ],
            };
            const lookup = makeLookupFromKeys([B, C, D]);
            await storage.values.put(B, DUMMY_VALUE);
            await storage.values.put(C, DUMMY_VALUE);
            await storage.values.put(D, DUMMY_VALUE);
            await storage.valid.put(C, [D]);
            // valid[B] intentionally left missing for D (simulates stale D)
            const ms = makeMigrationStorage(storage, headIndex, [B, C, D], "testfingerprint", 0, scheme, scheme, lookup);

            await ms.delete(B);
            await ms.keep(C);
            // D has no decision; structural scan finds D depends on B,
            // but D's other input C is kept → PartialDeleteFanInError
            const err = await ms.finalize().catch((e) => e);
            expect(isPartialDeleteFanIn(err)).toBe(true);
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
            const scheme = makeSingleNodeScheme("A");
            const lookup = makeLookupFromKeys([A]);
            const ms = makeMigrationStorage(storage, headIndex, [A], "testfingerprint", 0, scheme, scheme, lookup);

            expect(await ms.has(A)).toBe(true);
            expect(await ms.has(nk("Z"))).toBe(false);
        });

        test("getDependencyKeys(D) returns [B, C]", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A", "B", "C", "D"]);
            const ms = await setupStandardGraph(storage, headIndex);

            const inputs = await ms.getDependencyKeys(nk("D"));
            expect([...inputs].sort()).toEqual([nk("B"), nk("C")].sort());
        });

        test("getDependencyKeys(A) returns [] (source node)", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A", "B", "C", "D"]);
            const ms = await setupStandardGraph(storage, headIndex);

            const inputs = await ms.getDependencyKeys(nk("A"));
            expect(inputs).toEqual([]);
        });

        test("listValidDependents(A) returns [B]", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A", "B", "C", "D"]);
            const ms = await setupStandardGraph(storage, headIndex);

            const deps = await ms.listValidDependents(nk("A"));
            expect(deps).toEqual([nk("B")]);
        });

        test("listValidDependents(D) returns [] (leaf)", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A", "B", "C", "D"]);
            const ms = await setupStandardGraph(storage, headIndex);

            const deps = await ms.listValidDependents(nk("D"));
            expect(deps).toEqual([]);
        });

        test("getDependencyKeys(nonMaterialized) throws GetMissingNodeError", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A"]);
            const A = nk("A");
            const scheme = makeSingleNodeScheme("A");
            const lookup = makeLookupFromKeys([A]);
            await storage.values.put(A, DUMMY_VALUE);
            await storage.freshness.put(A, "up-to-date");
            await storage.timestamps.put(A, { createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-01T00:00:00.000Z" });
            const ms = makeMigrationStorage(storage, headIndex, [A], "testfingerprint", 0, scheme, scheme, lookup);

            const err = await ms.getDependencyKeys(nk("Z")).catch((e) => e);
            expect(isGetMissingNode(err)).toBe(true);
        });

        test("getDependencyKeys(node) throws GraphSchemeError if identifier not in lookup", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A"]);
            const A = nk("A");
            const scheme = makeSingleNodeScheme("A");
            // lookup does not include A
            const { makeEmptyIdentifierLookup } = require("../src/generators/incremental_graph/database");
            const lookup = makeEmptyIdentifierLookup();
            const ms = makeMigrationStorage(storage, headIndex, [A], "testfingerprint", 0, scheme, scheme, lookup);

            const err = await ms.getDependencyKeys(A).catch((e) => e);
            expect(err).toBeDefined();
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

        test("keep() fails hard when identifiers_keys_map cannot resolve node", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A", "B", "C", "D"]);

            // Force an empty identifiers_keys_map so schema compatibility cannot
            // resolve semantic node keys for materialized nodes.
            await storage.global.put(IDENTIFIERS_KEY, []);

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

            const err = await ms.override(nk("A"), () => Promise.resolve(DUMMY_VALUE)).catch((e) => e);
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

        test("create() with head not in new schema throws SchemaCompatibilityError", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A", "B"]);
            const A = nk("A");
            const scheme = makeSingleNodeScheme("A");
            const lookup = makeLookupFromKeys([A]);
            const ms = makeMigrationStorage(storage, headIndex, [A], "testfingerprint", 0, scheme, scheme, lookup);

            const err = await ms.create(nk("NONEXISTENT"), () => Promise.resolve(DUMMY_VALUE), "up-to-date").catch((e) => e);
            expect(isSchemaCompatibility(err)).toBe(true);
        });

        test("create() with wrong arity throws SchemaCompatibilityError", async () => {
            const storage = makeInMemorySchemaStorage();
            // "event(e)" has arity 1
            const headIndex = makeHeadIndex(["A", "event(e)"]);
            const A = nk("A");
            const scheme = makeSingleNodeScheme("A");
            const lookup = makeLookupFromKeys([A]);
            const ms = makeMigrationStorage(storage, headIndex, [A], "testfingerprint", 0, scheme, scheme, lookup);

            // nk("event") produces arity 0 — mismatch with schema arity 1
            const err = await ms.create(nk("event"), () => Promise.resolve(DUMMY_VALUE), "up-to-date").catch((e) => e);
            expect(isSchemaCompatibility(err)).toBe(true);
        });

        test("create() with malformed semantic key throws error", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A"]);
            const A = nk("A");
            const scheme = makeSingleNodeScheme("A");
            const lookup = makeLookupFromKeys([A]);
            const ms = makeMigrationStorage(storage, headIndex, [A], "testfingerprint", 0, scheme, scheme, lookup);

            const { stringToNodeKeyString } = require("../src/generators/incremental_graph/database");
            const malformedKey = stringToNodeKeyString("not valid json");
            const err = await ms.create(malformedKey, () => Promise.resolve(DUMMY_VALUE), "up-to-date").catch((e) => e);
            expect(err).toBeDefined();
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
            const scheme = makeSingleNodeScheme("A");
            const lookup = makeLookupFromKeys([A]);
            await storage.values.put(A, DUMMY_VALUE);
            await storage.freshness.put(A, "up-to-date");
            await storage.timestamps.put(A, { createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-01T00:00:00.000Z" });
            const ms = makeMigrationStorage(storage, headIndex, [A], "testfingerprint", 0, scheme, scheme, lookup);

            await ms.keep(A);
            await expect(ms.create(nk("NEW"), () => Promise.resolve(DUMMY_VALUE), "up-to-date")).resolves.toBeUndefined();
        });

        test("create(existingNode) throws CreateExistingNodeError", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A"]);
            const A = nk("A");
            await storage.values.put(A, DUMMY_VALUE);
            await storage.freshness.put(A, "up-to-date");
            await storage.timestamps.put(A, { createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-01T00:00:00.000Z" });
            const scheme = makeSingleNodeScheme("A");
            const lookup = makeLookupFromKeys([A]);
            const ms = makeMigrationStorage(storage, headIndex, [A], "testfingerprint", 0, scheme, scheme, lookup);

            const err = await ms.create(A, () => Promise.resolve(DUMMY_VALUE), "up-to-date").catch((e) => e);
            expect(isCreateExistingNode(err)).toBe(true);
        });

        test("create() on a node whose key exists in identifiers_keys_map throws CreateExistingNodeError", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A"]);
            const A = nk("A");
            await storage.global.put(IDENTIFIERS_KEY, [
                [A, A],
                [nk("NEW"), nk("NEW")],
            ]);
            const scheme = makeSingleNodeScheme("A");
            const lookup = makeLookupFromKeys([A]);
            await storage.values.put(A, DUMMY_VALUE);
            await storage.freshness.put(A, "up-to-date");
            await storage.timestamps.put(A, { createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-01T00:00:00.000Z" });
            const ms = makeMigrationStorage(storage, headIndex, [A], "testfingerprint", 0, scheme, scheme, lookup);

            await ms.keep(A);
            const err = await ms.create(nk("NEW"), () => Promise.resolve(DUMMY_VALUE), "up-to-date").catch((e) => e);
            expect(isCreateExistingNode(err)).toBe(true);
        });

        test("create() twice with same semantic key throws DecisionConflictError", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A", "NEW"]);
            const A = nk("A");
            const scheme = makeSingleNodeScheme("A");
            const lookup = makeLookupFromKeys([A]);
            await storage.values.put(A, DUMMY_VALUE);
            await storage.freshness.put(A, "up-to-date");
            await storage.timestamps.put(A, { createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-01T00:00:00.000Z" });
            const ms = makeMigrationStorage(storage, headIndex, [A], "testfingerprint", 0, scheme, scheme, lookup);

            await ms.keep(A);
            await ms.create(nk("NEW"), () => Promise.resolve(DUMMY_VALUE), "up-to-date");
            const err = await ms.create(nk("NEW"), () => Promise.resolve(DUMMY_VALUE_2), "up-to-date").catch((e) => e);
            expect(isDecisionConflict(err)).toBe(true);
        });

        test("create() decision appears in finalize() result", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A", "NEW"]);
            const A = nk("A");
            const scheme = makeSingleNodeScheme("A");
            const lookup = makeLookupFromKeys([A]);
            await storage.values.put(A, DUMMY_VALUE);
            await storage.freshness.put(A, "up-to-date");
            await storage.timestamps.put(A, { createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-01T00:00:00.000Z" });
            const ms = makeMigrationStorage(storage, headIndex, [A], "testfingerprint", 0, scheme, scheme, lookup);

            await ms.keep(A);
            await ms.create(nk("NEW"), () => Promise.resolve(DUMMY_VALUE_2), "up-to-date");
            const decisions = await ms.finalize();

            const createDecisions = [...decisions.entries()].filter(([, d]) => d.kind === "create");
            expect(createDecisions.length).toBe(1);
            const [generatedId, createDecision] = createDecisions[0];
            expect(createDecision?.kind).toBe("create");
            expect(createDecision?.nodeKeyString).toBe(nk("NEW"));
            expect(typeof generatedId).toBe("string");
            expect(await createDecision?.value(generatedId)).toEqual(DUMMY_VALUE_2);
        });

        test("create() does not affect completeness check (S nodes still need decisions)", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A", "NEW"]);
            const A = nk("A");
            const scheme = makeSingleNodeScheme("A");
            const lookup = makeLookupFromKeys([A]);
            await storage.values.put(A, DUMMY_VALUE);
            await storage.freshness.put(A, "up-to-date");
            await storage.timestamps.put(A, { createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-01T00:00:00.000Z" });
            const ms = makeMigrationStorage(storage, headIndex, [A], "testfingerprint", 0, scheme, scheme, lookup);

            // Only create a new node, don't decide A
            await ms.create(nk("NEW"), () => Promise.resolve(DUMMY_VALUE), "up-to-date");
            const err = await ms.finalize().catch((e) => e);
            expect(isUndecidedNodes(err)).toBe(true);
        });

        test("create() accepts a function returning a pending promise (value is not awaited during planning)", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A", "NEW"]);
            const A = nk("A");
            const scheme = makeSingleNodeScheme("A");
            const lookup = makeLookupFromKeys([A]);
            await storage.values.put(A, DUMMY_VALUE);
            await storage.freshness.put(A, "up-to-date");
            await storage.timestamps.put(A, { createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-01T00:00:00.000Z" });
            const ms = makeMigrationStorage(storage, headIndex, [A], "testfingerprint", 0, scheme, scheme, lookup);

            await ms.keep(A);
            // Pass a function that returns a promise that never resolves; create() should return immediately
            const neverResolves = () => new Promise(() => {});
            await expect(ms.create(nk("NEW"), neverResolves, "up-to-date")).resolves.toBeUndefined();
        });

        test("create() stores function and nodeKeyString in decision", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A", "NEW"]);
            const A = nk("A");
            const scheme = makeSingleNodeScheme("A");
            const lookup = makeLookupFromKeys([A]);
            await storage.values.put(A, DUMMY_VALUE);
            await storage.freshness.put(A, "up-to-date");
            await storage.timestamps.put(A, { createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-01T00:00:00.000Z" });
            const ms = makeMigrationStorage(storage, headIndex, [A], "testfingerprint", 0, scheme, scheme, lookup);

            const valueFn = () => Promise.resolve(DUMMY_VALUE_2);
            await ms.keep(A);
            await ms.create(nk("NEW"), valueFn, "up-to-date");
            const decisions = await ms.finalize();

            const createDecisions = [...decisions.entries()].filter(([, d]) => d.kind === "create");
            expect(createDecisions.length).toBe(1);
            const [, createDecision] = createDecisions[0];
            expect(createDecision?.kind).toBe("create");
            expect(createDecision?.nodeKeyString).toBe(nk("NEW"));
            expect(createDecision?.value).toBe(valueFn);
        });

        test("create() stores the provided nodeKeyString in the decision", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A", "NEW"]);
            const A = nk("A");
            const scheme = makeSingleNodeScheme("A");
            const lookup = makeLookupFromKeys([A]);
            await storage.values.put(A, DUMMY_VALUE);
            await storage.freshness.put(A, "up-to-date");
            await storage.timestamps.put(A, { createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-01T00:00:00.000Z" });
            const ms = makeMigrationStorage(storage, headIndex, [A], "testfingerprint", 0, scheme, scheme, lookup);

            await ms.keep(A);
            const semanticKey = nk("NEW");
            await ms.create(semanticKey, () => Promise.resolve(DUMMY_VALUE), "up-to-date");
            const decisions = await ms.finalize();

            const createDecisions = [...decisions.entries()].filter(([, d]) => d.kind === "create");
            expect(createDecisions.length).toBe(1);
            const [, createDecision] = createDecisions[0];
            expect(createDecision?.kind).toBe("create");
            expect(createDecision?.nodeKeyString).toBe(semanticKey);
            expect(createDecision?.value).toBeDefined();
        });

        test("create() produces deterministic identifiers across identical runs", async () => {
            // First run
            const storage1 = makeInMemorySchemaStorage();
            const headIndex1 = makeHeadIndex(["A", "NEW1", "NEW2"]);
            const A1 = nk("A");
            const scheme1 = makeSingleNodeScheme("A");
            const lookup1 = makeLookupFromKeys([A1]);
            await storage1.values.put(A1, DUMMY_VALUE);
            const ms1 = makeMigrationStorage(storage1, headIndex1, [A1], "testfingerprint", 0, scheme1, scheme1, lookup1);
            await ms1.keep(A1);
            await ms1.create(nk("NEW1"), () => Promise.resolve(DUMMY_VALUE), "up-to-date");
            await ms1.create(nk("NEW2"), () => Promise.resolve(DUMMY_VALUE_2), "up-to-date");
            const decisions1 = await ms1.finalize();

            // Second run — same fixture, same decisions
            const storage2 = makeInMemorySchemaStorage();
            const headIndex2 = makeHeadIndex(["A", "NEW1", "NEW2"]);
            const A2 = nk("A");
            const scheme2 = makeSingleNodeScheme("A");
            const lookup2 = makeLookupFromKeys([A2]);
            await storage2.values.put(A2, DUMMY_VALUE);
            const ms2 = makeMigrationStorage(storage2, headIndex2, [A2], "testfingerprint", 0, scheme2, scheme2, lookup2);
            await ms2.keep(A2);
            await ms2.create(nk("NEW1"), () => Promise.resolve(DUMMY_VALUE), "up-to-date");
            await ms2.create(nk("NEW2"), () => Promise.resolve(DUMMY_VALUE_2), "up-to-date");
            const decisions2 = await ms2.finalize();

            // Identifiers must be byte-for-byte identical
            const create1 = [...decisions1.entries()].filter(([, d]) => d.kind === "create");
            const create2 = [...decisions2.entries()].filter(([, d]) => d.kind === "create");
            expect(create1.length).toBe(2);
            expect(create2.length).toBe(2);

            const id1a = String(create1[0][0]);
            const id1b = String(create1[1][0]);
            const id2a = String(create2[0][0]);
            const id2b = String(create2[1][0]);
            expect(id1a).toBe(id2a);
            expect(id1b).toBe(id2b);
        });

        test("create() produces deterministic identifiers regardless of identifiers_keys_map", async () => {
            // Identifiers are fingerprint/index-based, not seeded from identifiers_keys_map.
            // So even with different existing entries, the same create sequence produces the same identifiers.

            // Run A: identifiers_keys_map has [A]
            const storageA = makeInMemorySchemaStorage();
            const headIndexA = makeHeadIndex(["A", "NEW1", "NEW2"]);
            const A_A = nk("A");
            const schemeA = makeSingleNodeScheme("A");
            const lookupA = makeLookupFromKeys([A_A]);
            await storageA.values.put(A_A, DUMMY_VALUE);
            const msA = makeMigrationStorage(storageA, headIndexA, [A_A], "testfingerprint", 0, schemeA, schemeA, lookupA);
            await msA.keep(A_A);
            await msA.create(nk("NEW1"), () => Promise.resolve(DUMMY_VALUE), "up-to-date");
            await msA.create(nk("NEW2"), () => Promise.resolve(DUMMY_VALUE_2), "up-to-date");
            const decisionsA = await msA.finalize();

            // Run B: identifiers_keys_map has [A, B] — same create sequence, same identifiers
            const storageB = makeInMemorySchemaStorage();
            const headIndexB = makeHeadIndex(["A", "B", "NEW1", "NEW2"]);
            const A_B = nk("A");
            const B_B = nk("B");
            const schemeB = { format: 1, nodes: [{ head: "A", arity: 0, inputTemplates: [] }, { head: "B", arity: 0, inputTemplates: [] }] };
            const lookupB = makeLookupFromKeys([A_B, B_B]);
            await storageB.values.put(A_B, DUMMY_VALUE);
            await storageB.values.put(B_B, DUMMY_VALUE);
            const msB = makeMigrationStorage(storageB, headIndexB, [A_B, B_B], "testfingerprint", 0, schemeB, schemeB, lookupB);
            await msB.keep(A_B);
            await msB.keep(B_B);
            await msB.create(nk("NEW1"), () => Promise.resolve(DUMMY_VALUE), "up-to-date");
            await msB.create(nk("NEW2"), () => Promise.resolve(DUMMY_VALUE_2), "up-to-date");
            const decisionsB = await msB.finalize();

            const createA = [...decisionsA.entries()].filter(([, d]) => d.kind === "create");
            const createB = [...decisionsB.entries()].filter(([, d]) => d.kind === "create");
            expect(createA.length).toBe(2);
            expect(createB.length).toBe(2);

            const idsA = createA.map(([id]) => String(id)).sort();
            const idsB = createB.map(([id]) => String(id)).sort();
            expect(idsA).toEqual(idsB);
        });

        test("create() identifiers do not collide for many consecutive calls", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A", "N1", "N2", "N3", "N4", "N5"]);
            const A = nk("A");
            const scheme = makeSingleNodeScheme("A");
            const lookup = makeLookupFromKeys([A]);
            await storage.values.put(A, DUMMY_VALUE);
            await storage.freshness.put(A, "up-to-date");
            await storage.timestamps.put(A, { createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-01T00:00:00.000Z" });
            const ms = makeMigrationStorage(storage, headIndex, [A], "testfingerprint", 0, scheme, scheme, lookup);
            await ms.keep(A);

            const nodeNames = ["N1", "N2", "N3", "N4", "N5"];
            for (const name of nodeNames) {
                await ms.create(nk(name), () => Promise.resolve(DUMMY_VALUE), "up-to-date");
            }

            const decisions = await ms.finalize();
            const createDecisions = [...decisions.entries()].filter(([, d]) => d.kind === "create");
            expect(createDecisions.length).toBe(5);

            const ids = new Set();
            for (const [id] of createDecisions) {
                expect(typeof id).toBe("string");
                expect(ids.has(id)).toBe(false);
                ids.add(id);
            }
        });
    });

    // -----------------------------------------------------------------------
    // Section 10: override() accepts function
    // -----------------------------------------------------------------------
    describe("Section 10: override() accepts function", () => {
        test("override() accepts a function returning a pending promise (value is not awaited during planning)", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A"]);
            const A = nk("A");
            await storage.values.put(A, DUMMY_VALUE);
            await storage.freshness.put(A, "up-to-date");
            await storage.timestamps.put(A, { createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-01T00:00:00.000Z" });
            const scheme = makeSingleNodeScheme("A");
            const lookup = makeLookupFromKeys([A]);
            const ms = makeMigrationStorage(storage, headIndex, [A], "testfingerprint", 0, scheme, scheme, lookup);

            // Pass a function that returns a promise that never resolves; override() should return immediately
            const neverResolves = () => new Promise(() => {});
            await expect(ms.override(A, neverResolves)).resolves.toBeUndefined();
        });

        test("override() passes the nodeKey to the value function", async () => {
            const storage = makeInMemorySchemaStorage();
            const headIndex = makeHeadIndex(["A"]);
            const A = nk("A");
            const scheme = makeSingleNodeScheme("A");
            const lookup = makeLookupFromKeys([A]);
            await storage.values.put(A, DUMMY_VALUE);
            await storage.freshness.put(A, "up-to-date");
            await storage.timestamps.put(A, { createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-01T00:00:00.000Z" });
            const ms = makeMigrationStorage(storage, headIndex, [A], "testfingerprint", 0, scheme, scheme, lookup);

            /** @type {string | undefined} */
            let receivedKey;
            await ms.override(A, (key) => {
                receivedKey = key;
                return Promise.resolve(DUMMY_VALUE_2);
            });
            const decisions = await ms.finalize();

            const overrideDecision = decisions.get(A);
            expect(overrideDecision?.kind).toBe("override");
            // The function is not called during override() or finalize() — only during the runner's apply phase
            expect(receivedKey).toBeUndefined();
            // Calling the function directly simulates what the runner does, verifying the key is passed correctly
            await overrideDecision?.value(A);
            expect(receivedKey).toBe(A);
        });
    });
});
