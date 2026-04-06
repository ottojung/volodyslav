/**
 * Tests that verify timestamps are correctly copied during database migration.
 *
 * Each decision type (keep, override, invalidate) must preserve the timestamps
 * that were recorded in the previous schema version, so that creation/modification
 * history survives across version upgrades.
 */

const { runMigration } = require("../src/generators/incremental_graph/migration_runner");
const { toJsonKey } = require("./test_json_key_helper");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger, stubDatetime, stubEnvironment } = require("./stubs");
jest.mock('../src/generators/incremental_graph/database', () => ({
    ...jest.requireActual('../src/generators/incremental_graph/database'),
    runMigrationInTransaction: jest.fn(),
}));
const { runMigrationInTransaction: mockRunMigrationInTransaction } = require('../src/generators/incremental_graph/database');

// ─────────────────────────────────────────────────────────────────────────────
// Shared test infrastructure
// ─────────────────────────────────────────────────────────────────────────────

function makeInMemoryDb(table) {
    const store = new Map();
    return {
        async get(key) { return store.get(key); },
        async put(key, value) { store.set(key, value); },
        putOp(key, value) { return { type: "put", table, key, value }; },
        async *keys() { for (const key of store.keys()) yield key; },
        apply(operation) {
            if (operation.type === "put" && operation.table === table) {
                store.set(operation.key, operation.value);
            }
        },
    };
}

function makeSchemaStorage() {
    const values = makeInMemoryDb("values");
    const freshness = makeInMemoryDb("freshness");
    const inputs = makeInMemoryDb("inputs");
    const revdeps = makeInMemoryDb("revdeps");
    const counters = makeInMemoryDb("counters");
    const timestamps = makeInMemoryDb("timestamps");

    return {
        values, freshness, inputs, revdeps, counters, timestamps,
        async batch(operations) {
            for (const op of operations) {
                values.apply(op);
                freshness.apply(op);
                inputs.apply(op);
                revdeps.apply(op);
                counters.apply(op);
                timestamps.apply(op);
            }
        },
    };
}

function makeRootDatabaseMock({ prevVersion, currentVersion, xStorage, yStorage }) {
    const rootDatabase = {
        version: currentVersion,
        async getMetaVersion() { return prevVersion; },
        getSchemaStorage() { return xStorage; },
        currentReplicaName() { return 'x'; },
        otherReplicaName() { return 'y'; },
        schemaStorageForReplica(name) { return name === 'x' ? xStorage : yStorage; },
        async clearReplicaStorage(_name) {},
        async setMetaVersionForReplica(_name, _v) {},
        async switchToReplica(_name) {},
        async setMetaVersion(_v) {},
    };
    return { rootDatabase };
}

/**
 * Creates test capabilities.
 * @returns {Promise<object>}
 */
async function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    mockRunMigrationInTransaction.mockReset();
    mockRunMigrationInTransaction.mockImplementation(async (_caps, _db, _pre, _post, callback) => await callback());
    capabilities.runMigrationInTransaction = mockRunMigrationInTransaction;
    return capabilities;
}

/** Timestamp fixture for a node first computed a long time ago and modified recently. */
const OLD_TIMESTAMP = {
    createdAt: "2024-01-01T00:00:00.000Z",
    modifiedAt: "2024-06-15T12:00:00.000Z",
};

/** Timestamp fixture for a newly created node. */
const NEW_TIMESTAMP = {
    createdAt: "2025-03-01T10:00:00.000Z",
    modifiedAt: "2025-03-01T10:00:00.000Z",
};

/** Build a minimal single-node NodeDef array for node "A". */
function makeNodeDefs(names) {
    return names.map((name, idx, arr) => ({
        output: name,
        inputs: idx > 0 ? [arr[idx - 1]] : [],
        computor: async () => ({ type: "all_events", events: [] }),
        isDeterministic: true,
        hasSideEffects: false,
    }));
}

/** Seed a node in storage with value, inputs, freshness, counter, and optional timestamps. */
async function seedNode(storage, nodeKey, {
    timestamps = undefined,
    counter = 1,
    freshness = "up-to-date",
    inputs = [],
    inputCounters = [],
} = {}) {
    await storage.values.put(nodeKey, { type: "all_events", events: [] });
    await storage.freshness.put(nodeKey, freshness);
    await storage.inputs.put(nodeKey, { inputs, inputCounters });
    await storage.counters.put(nodeKey, counter);
    if (timestamps !== undefined) {
        await storage.timestamps.put(nodeKey, timestamps);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// keep decision copies timestamps
// ─────────────────────────────────────────────────────────────────────────────

describe("keep decision: timestamps copied to new storage", () => {
    test("both createdAt and modifiedAt are identical in new storage after keep", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");

        await seedNode(xStorage, nodeKey, { timestamps: OLD_TIMESTAMP });
        const { rootDatabase } = makeRootDatabaseMock({
            prevVersion: "1", currentVersion: "2", xStorage, yStorage,
        });

        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A"]), async (storage) => {
            await storage.keep(nodeKey);
        });

        await expect(yStorage.timestamps.get(nodeKey)).resolves.toEqual(OLD_TIMESTAMP);
    });

    test("createdAt is preserved exactly after keep", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");

        await seedNode(xStorage, nodeKey, { timestamps: OLD_TIMESTAMP });
        const { rootDatabase } = makeRootDatabaseMock({
            prevVersion: "1", currentVersion: "2", xStorage, yStorage,
        });

        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A"]), async (storage) => {
            await storage.keep(nodeKey);
        });

        const result = await yStorage.timestamps.get(nodeKey);
        expect(result.createdAt).toBe(OLD_TIMESTAMP.createdAt);
    });

    test("modifiedAt is preserved exactly after keep", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");

        await seedNode(xStorage, nodeKey, { timestamps: OLD_TIMESTAMP });
        const { rootDatabase } = makeRootDatabaseMock({
            prevVersion: "1", currentVersion: "2", xStorage, yStorage,
        });

        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A"]), async (storage) => {
            await storage.keep(nodeKey);
        });

        const result = await yStorage.timestamps.get(nodeKey);
        expect(result.modifiedAt).toBe(OLD_TIMESTAMP.modifiedAt);
    });

    test("node with no previous timestamp keeps no timestamp after keep", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");

        await seedNode(xStorage, nodeKey); // no timestamps
        const { rootDatabase } = makeRootDatabaseMock({
            prevVersion: "1", currentVersion: "2", xStorage, yStorage,
        });

        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A"]), async (storage) => {
            await storage.keep(nodeKey);
        });

        await expect(yStorage.timestamps.get(nodeKey)).resolves.toBeUndefined();
    });

    test("multiple nodes: all timestamps copied correctly on keep", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const nkA = toJsonKey("A");
        const nkB = toJsonKey("B");

        await seedNode(xStorage, nkA, { timestamps: OLD_TIMESTAMP });
        await seedNode(xStorage, nkB, {
            timestamps: NEW_TIMESTAMP,
            inputs: [nkA],
            inputCounters: [1],
        });
        await xStorage.revdeps.put(nkA, [nkB]);
        const { rootDatabase } = makeRootDatabaseMock({
            prevVersion: "1", currentVersion: "2", xStorage, yStorage,
        });

        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A", "B"]), async (storage) => {
            await storage.keep(nkA);
            await storage.keep(nkB);
        });

        await expect(yStorage.timestamps.get(nkA)).resolves.toEqual(OLD_TIMESTAMP);
        await expect(yStorage.timestamps.get(nkB)).resolves.toEqual(NEW_TIMESTAMP);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// override decision copies timestamps
// ─────────────────────────────────────────────────────────────────────────────

describe("override decision: timestamps copied to new storage", () => {
    test("both createdAt and modifiedAt are preserved after override", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");

        await seedNode(xStorage, nodeKey, { timestamps: OLD_TIMESTAMP });
        const { rootDatabase } = makeRootDatabaseMock({
            prevVersion: "1", currentVersion: "2", xStorage, yStorage,
        });

        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A"]), async (storage) => {
            await storage.override(nodeKey, async () => ({ type: "all_events", events: [] }));
        });

        await expect(yStorage.timestamps.get(nodeKey)).resolves.toEqual(OLD_TIMESTAMP);
    });

    test("override without previous timestamp leaves timestamps absent", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");

        await seedNode(xStorage, nodeKey); // no timestamps
        const { rootDatabase } = makeRootDatabaseMock({
            prevVersion: "1", currentVersion: "2", xStorage, yStorage,
        });

        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A"]), async (storage) => {
            await storage.override(nodeKey, async () => ({ type: "all_events", events: [] }));
        });

        await expect(yStorage.timestamps.get(nodeKey)).resolves.toBeUndefined();
    });

    test("override createdAt survives when modifiedAt differs", async () => {
        const capabilities = await getTestCapabilities();
        const ts = { createdAt: "2023-05-01T00:00:00.000Z", modifiedAt: "2024-11-30T23:59:59.000Z" };
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");

        await seedNode(xStorage, nodeKey, { timestamps: ts });
        const { rootDatabase } = makeRootDatabaseMock({
            prevVersion: "1", currentVersion: "2", xStorage, yStorage,
        });

        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A"]), async (storage) => {
            await storage.override(nodeKey, async () => ({ type: "all_events", events: [] }));
        });

        const result = await yStorage.timestamps.get(nodeKey);
        expect(result.createdAt).toBe(ts.createdAt);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// invalidate decision copies timestamps
// ─────────────────────────────────────────────────────────────────────────────

describe("invalidate decision: timestamps copied to new storage", () => {
    test("both createdAt and modifiedAt are preserved after invalidate", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");

        await seedNode(xStorage, nodeKey, { timestamps: OLD_TIMESTAMP });
        const { rootDatabase } = makeRootDatabaseMock({
            prevVersion: "1", currentVersion: "2", xStorage, yStorage,
        });

        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A"]), async (storage) => {
            await storage.invalidate(nodeKey);
        });

        await expect(yStorage.timestamps.get(nodeKey)).resolves.toEqual(OLD_TIMESTAMP);
    });

    test("invalidate without previous timestamp leaves timestamps absent", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");

        await seedNode(xStorage, nodeKey); // no timestamps
        const { rootDatabase } = makeRootDatabaseMock({
            prevVersion: "1", currentVersion: "2", xStorage, yStorage,
        });

        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A"]), async (storage) => {
            await storage.invalidate(nodeKey);
        });

        await expect(yStorage.timestamps.get(nodeKey)).resolves.toBeUndefined();
    });

    test("invalidate preserves createdAt even though value is stale", async () => {
        const capabilities = await getTestCapabilities();
        const ts = { createdAt: "2022-01-01T00:00:00.000Z", modifiedAt: "2022-01-01T00:00:00.000Z" };
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");

        await seedNode(xStorage, nodeKey, { timestamps: ts, freshness: "up-to-date" });
        const { rootDatabase } = makeRootDatabaseMock({
            prevVersion: "1", currentVersion: "2", xStorage, yStorage,
        });

        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A"]), async (storage) => {
            await storage.invalidate(nodeKey);
        });

        const result = await yStorage.timestamps.get(nodeKey);
        expect(result.createdAt).toBe(ts.createdAt);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// delete decision: timestamps NOT copied
// ─────────────────────────────────────────────────────────────────────────────

describe("delete decision: timestamps not present in new storage", () => {
    test("deleted node has no timestamp entry in new storage", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const nkA = toJsonKey("A");
        const nkB = toJsonKey("B");

        await seedNode(xStorage, nkA, { timestamps: OLD_TIMESTAMP });
        await seedNode(xStorage, nkB, {
            timestamps: NEW_TIMESTAMP,
            inputs: [nkA],
            inputCounters: [1],
        });
        await xStorage.revdeps.put(nkA, [nkB]);
        const { rootDatabase } = makeRootDatabaseMock({
            prevVersion: "1", currentVersion: "2", xStorage, yStorage,
        });

        // Deleting both; B auto-deleted because A is deleted (fan-out propagation)
        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A", "B"]), async (storage) => {
            await storage.delete(nkA);
            await storage.delete(nkB);
        });

        await expect(yStorage.timestamps.get(nkA)).resolves.toBeUndefined();
        await expect(yStorage.timestamps.get(nkB)).resolves.toBeUndefined();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Two-node chain: independent decision combinations
// ─────────────────────────────────────────────────────────────────────────────

describe("two-node chain: mixed decision timestamp behaviour", () => {
    async function buildChain(xStorage) {
        const nkA = toJsonKey("A");
        const nkB = toJsonKey("B");
        await seedNode(xStorage, nkA, { timestamps: OLD_TIMESTAMP, counter: 3 });
        await seedNode(xStorage, nkB, {
            timestamps: NEW_TIMESTAMP,
            inputs: [nkA],
            inputCounters: [3],
            counter: 7,
        });
        await xStorage.revdeps.put(nkA, [nkB]);
        return { nkA, nkB };
    }

    test("keep A, keep B: both timestamps preserved", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const { nkA, nkB } = await buildChain(xStorage);
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yStorage });

        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A", "B"]), async (storage) => {
            await storage.keep(nkA);
            await storage.keep(nkB);
        });

        await expect(yStorage.timestamps.get(nkA)).resolves.toEqual(OLD_TIMESTAMP);
        await expect(yStorage.timestamps.get(nkB)).resolves.toEqual(NEW_TIMESTAMP);
    });

    test("keep A, invalidate B: both timestamps preserved", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const { nkA, nkB } = await buildChain(xStorage);
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yStorage });

        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A", "B"]), async (storage) => {
            await storage.keep(nkA);
            await storage.invalidate(nkB);
        });

        await expect(yStorage.timestamps.get(nkA)).resolves.toEqual(OLD_TIMESTAMP);
        await expect(yStorage.timestamps.get(nkB)).resolves.toEqual(NEW_TIMESTAMP);
    });

    test("keep A, override B: A timestamp preserved; B timestamp preserved (createdAt unchanged)", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const { nkA, nkB } = await buildChain(xStorage);
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yStorage });

        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A", "B"]), async (storage) => {
            await storage.keep(nkA);
            await storage.override(nkB, async () => ({ type: "all_events", events: [] }));
        });

        await expect(yStorage.timestamps.get(nkA)).resolves.toEqual(OLD_TIMESTAMP);
        const bResult = await yStorage.timestamps.get(nkB);
        expect(bResult.createdAt).toBe(NEW_TIMESTAMP.createdAt);
    });

    test("override A, B auto-invalidated: both timestamps preserved", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const { nkA, nkB } = await buildChain(xStorage);
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yStorage });

        // Override A; B is automatically invalidated (it depends on A)
        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A", "B"]), async (storage) => {
            await storage.override(nkA, async () => ({ type: "all_events", events: [] }));
            // nkB is auto-invalidated by override(nkA)
        });

        await expect(yStorage.timestamps.get(nkA)).resolves.toEqual(OLD_TIMESTAMP);
        await expect(yStorage.timestamps.get(nkB)).resolves.toEqual(NEW_TIMESTAMP);
    });

    test("invalidate A, invalidate B: both timestamps preserved", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const { nkA, nkB } = await buildChain(xStorage);
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yStorage });

        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A", "B"]), async (storage) => {
            await storage.invalidate(nkA);
            await storage.invalidate(nkB);
        });

        await expect(yStorage.timestamps.get(nkA)).resolves.toEqual(OLD_TIMESTAMP);
        await expect(yStorage.timestamps.get(nkB)).resolves.toEqual(NEW_TIMESTAMP);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Failed migration: x-namespace timestamps unchanged
// ─────────────────────────────────────────────────────────────────────────────

describe("failed migration: x-namespace timestamps unchanged", () => {
    test("callback throws: timestamp in x-namespace is unchanged", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");

        await seedNode(xStorage, nodeKey, { timestamps: OLD_TIMESTAMP });
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yStorage });

        await expect(
            runMigration(capabilities, rootDatabase, makeNodeDefs(["A"]), async () => {
                throw new Error("boom");
            })
        ).rejects.toThrow("boom");

        await expect(xStorage.timestamps.get(nodeKey)).resolves.toEqual(OLD_TIMESTAMP);
    });

    test("UndecidedNodesError: timestamp in x-namespace is unchanged", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const nkA = toJsonKey("A");
        const nkB = toJsonKey("B");

        await seedNode(xStorage, nkA, { timestamps: OLD_TIMESTAMP });
        await seedNode(xStorage, nkB, { timestamps: NEW_TIMESTAMP });
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "v1", currentVersion: "v2", xStorage, yStorage });

        await expect(
            runMigration(capabilities, rootDatabase, makeNodeDefs(["A", "B"]), async (storage) => {
                await storage.keep(nkA);
                // B left undecided
            })
        ).rejects.toThrow();

        await expect(xStorage.timestamps.get(nkA)).resolves.toEqual(OLD_TIMESTAMP);
        await expect(xStorage.timestamps.get(nkB)).resolves.toEqual(NEW_TIMESTAMP);
    });
});
