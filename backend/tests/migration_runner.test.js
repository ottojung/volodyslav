/**
 * Integration tests for runMigration — the migration runner for incremental graph.
 *
 * These tests use in-memory mocks of RootDatabase and SchemaStorage so no LevelDB
 * process is required.
 */

const { runMigration } = require("../src/generators/incremental_graph/migration_runner");
const {
    isSchemaCompatibility,
    isUndecidedNodes,
    isPartialDeleteFanIn,
} = require("../src/generators/incremental_graph/migration_errors");
const { toJsonKey } = require("./test_json_key_helper");

// ---------------------------------------------------------------------------
// In-memory mock infrastructure
// ---------------------------------------------------------------------------

/**
 * Creates an in-memory database that supports get/put/del/putOp/delOp/keys/clear.
 * The putOp/delOp operations include a reference to the internal store so that
 * the SchemaStorage batch function can apply them.
 */
function makeInMemoryDb() {
    const store = new Map();
    const db = {
        async get(key) { return store.get(key); },
        async put(key, value) { store.set(key, value); },
        async del(key) { store.delete(key); },
        putOp(key, value) { return { type: "put", sublevel: db, key, value }; },
        delOp(key) { return { type: "del", sublevel: db, key }; },
        async *keys() { for (const k of store.keys()) yield k; },
        async clear() { store.clear(); },
        _store: store,
    };
    return db;
}

/**
 * Creates an in-memory SchemaStorage.
 * The batch() function routes each operation back to the correct in-memory db
 * using the sublevel reference embedded in each op by putOp/delOp.
 */
function makeInMemorySchemaStorage() {
    const values = makeInMemoryDb();
    const freshness = makeInMemoryDb();
    const inputs = makeInMemoryDb();
    const revdeps = makeInMemoryDb();
    const counters = makeInMemoryDb();

    return {
        values,
        freshness,
        inputs,
        revdeps,
        counters,
        async batch(ops) {
            for (const op of ops) {
                if (op.type === "put") {
                    op.sublevel._store.set(op.key, op.value);
                } else if (op.type === "del") {
                    op.sublevel._store.delete(op.key);
                }
            }
        },
    };
}

/**
 * Creates a mock RootDatabase with an optional previous-version storage.
 *
 * @param {string} newVersion - The new (current) application version string.
 * @param {string | null} prevVersion - The previous application version string, or null.
 * @returns {{ db: object, prevStorage: object | null, newStorage: object }}
 */
function makeInMemoryRootDatabase(newVersion, prevVersion = null) {
    const storages = new Map();
    const prevStorage = prevVersion !== null ? makeInMemorySchemaStorage() : null;
    const newStorage = makeInMemorySchemaStorage();

    if (prevVersion !== null) {
        storages.set(prevVersion, prevStorage);
    }
    storages.set(newVersion, newStorage);

    const db = {
        version: newVersion,
        async *listSchemas() {
            for (const v of storages.keys()) {
                yield v;
            }
        },
        getSchemaStorageForVersion(v) {
            const s = storages.get(v);
            if (!s) throw new Error(`No storage for version ${v}`);
            return s;
        },
        getSchemaStorage() {
            return this.getSchemaStorageForVersion(this.version);
        },
    };

    return { db, prevStorage, newStorage };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** NodeKeyString for a zero-arity node named `name`. */
const nk = (name) => toJsonKey(name);

const DUMMY_VALUE = { type: "all_events", events: [] };
const DUMMY_VALUE_2 = { type: "meta_events", meta_events: [] };

/**
 * Populate a standard test graph into a SchemaStorage.
 *
 * Graph topology:  A → B (both zero-arity)
 */
async function populateTwoNodeGraph(storage) {
    const A = nk("A"), B = nk("B");

    await storage.values.put(A, DUMMY_VALUE);
    await storage.values.put(B, DUMMY_VALUE_2);

    await storage.inputs.put(A, { inputs: [], inputCounters: [] });
    await storage.inputs.put(B, { inputs: [A], inputCounters: [1] });

    await storage.revdeps.put(A, [B]);
    await storage.freshness.put(A, "up-to-date");
    await storage.freshness.put(B, "up-to-date");
}

/**
 * Minimal NodeDef factory for a zero-arity node.
 * @param {string} name
 */
function makeNodeDef(name) {
    return {
        output: name,
        inputs: [],
        computor: async () => DUMMY_VALUE,
        isDeterministic: true,
        hasSideEffects: false,
        migrations: {},
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runMigration()", () => {
    // -----------------------------------------------------------------------
    // No-op when there is no previous version
    // -----------------------------------------------------------------------
    test("is a no-op when there is no previous version", async () => {
        const { db, newStorage } = makeInMemoryRootDatabase("v2");

        const callbackCalled = { value: false };
        await runMigration(db, [makeNodeDef("A")], async () => {
            callbackCalled.value = true;
        });

        expect(callbackCalled.value).toBe(false);
        expect([...newStorage.values._store.keys()]).toHaveLength(0);
    });

    // -----------------------------------------------------------------------
    // Basic keep decision
    // -----------------------------------------------------------------------
    test("keep decision copies value and marks up-to-date in new version", async () => {
        const { db, prevStorage, newStorage } = makeInMemoryRootDatabase("v2", "v1");
        await populateTwoNodeGraph(prevStorage);

        await runMigration(db, [makeNodeDef("A"), makeNodeDef("B")], async (storage) => {
            for await (const nodeKey of storage.listMaterializedNodes()) {
                await storage.keep(nodeKey);
            }
        });

        expect(await newStorage.values.get(nk("A"))).toEqual(DUMMY_VALUE);
        expect(await newStorage.values.get(nk("B"))).toEqual(DUMMY_VALUE_2);
        expect(await newStorage.freshness.get(nk("A"))).toBe("up-to-date");
        expect(await newStorage.freshness.get(nk("B"))).toBe("up-to-date");
    });

    // -----------------------------------------------------------------------
    // Basic invalidate decision
    // -----------------------------------------------------------------------
    test("invalidate decision marks potentially-outdated and writes no value", async () => {
        const { db, prevStorage, newStorage } = makeInMemoryRootDatabase("v2", "v1");
        await populateTwoNodeGraph(prevStorage);

        await runMigration(db, [makeNodeDef("A"), makeNodeDef("B")], async (storage) => {
            for await (const nodeKey of storage.listMaterializedNodes()) {
                await storage.invalidate(nodeKey);
            }
        });

        expect(await newStorage.values.get(nk("A"))).toBeUndefined();
        expect(await newStorage.freshness.get(nk("A"))).toBe("potentially-outdated");
    });

    // -----------------------------------------------------------------------
    // Basic override decision
    // -----------------------------------------------------------------------
    test("override decision writes new value and marks up-to-date", async () => {
        const { db, prevStorage, newStorage } = makeInMemoryRootDatabase("v2", "v1");
        await populateTwoNodeGraph(prevStorage);

        const newValue = { type: "all_events", events: ["x"] };
        await runMigration(db, [makeNodeDef("A"), makeNodeDef("B")], async (storage) => {
            await storage.override(nk("A"), newValue);
            // override(A) automatically propagates INVALIDATE to B (its dependent),
            // so all nodes in S already have decisions after this single call.
        });

        expect(await newStorage.values.get(nk("A"))).toEqual(newValue);
        expect(await newStorage.freshness.get(nk("A"))).toBe("up-to-date");
        // B was invalidated by propagation from override(A)
        expect(await newStorage.freshness.get(nk("B"))).toBe("potentially-outdated");
    });

    // -----------------------------------------------------------------------
    // Basic delete decision
    // -----------------------------------------------------------------------
    test("delete(A) and delete(B) removes both from new version", async () => {
        const { db, prevStorage, newStorage } = makeInMemoryRootDatabase("v2", "v1");
        await populateTwoNodeGraph(prevStorage);

        await runMigration(db, [makeNodeDef("A"), makeNodeDef("B")], async (storage) => {
            await storage.delete(nk("A"));
            await storage.delete(nk("B"));
        });

        expect(await newStorage.values.get(nk("A"))).toBeUndefined();
        expect(await newStorage.values.get(nk("B"))).toBeUndefined();
        expect(await newStorage.freshness.get(nk("A"))).toBeUndefined();
        expect(await newStorage.freshness.get(nk("B"))).toBeUndefined();
    });

    // -----------------------------------------------------------------------
    // Schema compatibility: keep on a node absent from new schema
    // -----------------------------------------------------------------------
    test("keep() on a node absent from new schema throws SchemaCompatibilityError", async () => {
        const { db, prevStorage } = makeInMemoryRootDatabase("v2", "v1");
        await populateTwoNodeGraph(prevStorage);

        // New schema has only B — A is removed
        const newNodeDefs = [makeNodeDef("B")];

        const err = await runMigration(db, newNodeDefs, async (storage) => {
            // keep(A) should throw SchemaCompatibilityError since A is not in new schema
            await storage.keep(nk("A"));
        }).catch((e) => e);

        expect(isSchemaCompatibility(err)).toBe(true);
    });

    // -----------------------------------------------------------------------
    // Schema compatibility: invalidate on a node absent from new schema
    // -----------------------------------------------------------------------
    test("invalidate() on a node absent from new schema throws SchemaCompatibilityError", async () => {
        const { db, prevStorage } = makeInMemoryRootDatabase("v2", "v1");
        await populateTwoNodeGraph(prevStorage);

        // New schema has only B — A is removed
        const newNodeDefs = [makeNodeDef("B")];

        const err = await runMigration(db, newNodeDefs, async (storage) => {
            // invalidate(A) should throw SchemaCompatibilityError since A is not in new schema
            await storage.invalidate(nk("A"));
        }).catch((e) => e);

        expect(isSchemaCompatibility(err)).toBe(true);
    });

    // -----------------------------------------------------------------------
    // Schema compatibility: override on a node absent from new schema
    // -----------------------------------------------------------------------
    test("override() on a node absent from new schema throws SchemaCompatibilityError", async () => {
        const { db, prevStorage } = makeInMemoryRootDatabase("v2", "v1");
        await populateTwoNodeGraph(prevStorage);

        // New schema has only B — A is removed
        const newNodeDefs = [makeNodeDef("B")];

        const err = await runMigration(db, newNodeDefs, async (storage) => {
            // override(A) should throw SchemaCompatibilityError since A is not in new schema
            await storage.override(nk("A"), DUMMY_VALUE);
        }).catch((e) => e);

        expect(isSchemaCompatibility(err)).toBe(true);
    });

    // -----------------------------------------------------------------------
    // Schema compatibility: delete on a node absent from new schema succeeds
    // -----------------------------------------------------------------------
    test("delete() on a node absent from new schema succeeds", async () => {
        const { db, prevStorage } = makeInMemoryRootDatabase("v2", "v1");
        await populateTwoNodeGraph(prevStorage);

        // New schema has only B — A is removed
        const newNodeDefs = [makeNodeDef("B")];

        // delete A (absent from new schema) — must succeed
        // B's only input is A; once A is deleted, B is auto-deleted during finalize
        await expect(
            runMigration(db, newNodeDefs, async (storage) => {
                await storage.delete(nk("A"));
            })
        ).resolves.toBeUndefined();
    });

    // -----------------------------------------------------------------------
    // Completeness: undecided nodes cause UndecidedNodesError
    // -----------------------------------------------------------------------
    test("leaving nodes undecided causes UndecidedNodesError from finalize", async () => {
        const { db, prevStorage } = makeInMemoryRootDatabase("v2", "v1");
        await populateTwoNodeGraph(prevStorage);

        const err = await runMigration(
            db,
            [makeNodeDef("A"), makeNodeDef("B")],
            async (storage) => {
                // Only decide A; leave B undecided
                await storage.keep(nk("A"));
            }
        ).catch((e) => e);

        expect(isUndecidedNodes(err)).toBe(true);
    });

    // -----------------------------------------------------------------------
    // Fan-in restriction
    // -----------------------------------------------------------------------
    test("deleting only one input of a fan-in node throws PartialDeleteFanInError", async () => {
        // Build a fan-in graph: C = f(A, B)
        const { db, prevStorage } = makeInMemoryRootDatabase("v2", "v1");
        const A = nk("A"), B = nk("B"), C = nk("C");

        await prevStorage.values.put(A, DUMMY_VALUE);
        await prevStorage.values.put(B, DUMMY_VALUE);
        await prevStorage.values.put(C, DUMMY_VALUE);
        await prevStorage.inputs.put(A, { inputs: [], inputCounters: [] });
        await prevStorage.inputs.put(B, { inputs: [], inputCounters: [] });
        await prevStorage.inputs.put(C, { inputs: [A, B], inputCounters: [1, 1] });
        await prevStorage.revdeps.put(A, [C]);
        await prevStorage.revdeps.put(B, [C]);

        const err = await runMigration(
            db,
            [makeNodeDef("A"), makeNodeDef("B"), makeNodeDef("C")],
            async (storage) => {
                await storage.keep(nk("A"));
                await storage.delete(nk("B")); // only B deleted; A is not → C cannot be auto-deleted
                await storage.keep(nk("C"));
            }
        ).catch((e) => e);

        expect(isPartialDeleteFanIn(err)).toBe(true);
    });

    // -----------------------------------------------------------------------
    // Override idempotency
    // -----------------------------------------------------------------------
    test("override() twice with the same value is idempotent", async () => {
        const { db, prevStorage } = makeInMemoryRootDatabase("v2", "v1");
        await populateTwoNodeGraph(prevStorage);

        await expect(
            runMigration(db, [makeNodeDef("A"), makeNodeDef("B")], async (storage) => {
                await storage.override(nk("A"), DUMMY_VALUE);
                await storage.override(nk("A"), DUMMY_VALUE); // same value → idempotent
                // B was auto-invalidated by override(A) propagation
            })
        ).resolves.toBeUndefined();
    });
});
