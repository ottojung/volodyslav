/**
 * Tests that verify timestamps are correctly copied during database migration.
 *
 * Each decision type (keep, override, invalidate) must preserve the timestamps
 * that were recorded in the previous schema version, so that creation/modification
 * history survives across version upgrades.
 */

const { runMigration } = require("../src/generators/incremental_graph/migration_runner");
const {
    IDENTIFIERS_KEY,
    nodeIdentifierToString,
} = require("../src/generators/incremental_graph/database");
const { toJsonKey } = require("./test_json_key_helper");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger, stubDatetime, stubEnvironment } = require("./stubs");
jest.mock('../src/generators/incremental_graph/database', () => ({
    ...jest.requireActual('../src/generators/incremental_graph/database'),
    checkpointMigration: jest.fn(),
}));
const { checkpointMigration: mockCheckpointMigration } = require('../src/generators/incremental_graph/database');

// ─────────────────────────────────────────────────────────────────────────────
// Shared test infrastructure
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read an entry from yStorage using the migrated identifier for the given node key.
 * @template T
 * @param {{ get: (key: string) => Promise<T | undefined> }} sublevel
 * @param {import('../src/generators/incremental_graph/database').SchemaStorage} yStorage
 * @param {string} nodeKey
 * @returns {Promise<T | undefined>}
 */
async function yGet(sublevel, yStorage, nodeKey) {
    const entries = await yStorage.global.get(IDENTIFIERS_KEY);
    if (!entries) return sublevel.get(nodeKey);
    const entry = entries.find(([, key]) => String(key) === nodeKey);
    const id = entry ? nodeIdentifierToString(entry[0]) : nodeKey;
    return sublevel.get(id);
}

/** Collect all keys from a sublevel (preserves whether a key exists even if its value is `undefined`). */
async function collectKeys(sublevel) {
    const out = [];
    for await (const key of sublevel.keys()) {
        out.push(key);
    }
    return out;
}

function makeInMemoryDb(table) {
    const store = new Map();
    return {
        async get(key) { return store.get(key); },
        async put(key, value) { store.set(key, value); },
        async noFlushPut(key, value) { store.set(key, value); },
        async del(key) { store.delete(key); },
        async noFlushDel(key) { store.delete(key); },
        putOp(key, value) { return { type: "put", table, key, value }; },
        delOp(key) { return { type: "del", table, key }; },
        async *keys() {
            for (const key of [...store.keys()].sort()) yield key;
        },
        apply(operation) {
            if (operation.table === table) {
                if (operation.type === "put") {
                    store.set(operation.key, operation.value);
                } else if (operation.type === "del") {
                    store.delete(operation.key);
                }
            }
        },
    };
}

function makeSchemaStorage() {
    const values = makeInMemoryDb("values");
    const freshness = makeInMemoryDb("freshness");
    const global = makeInMemoryDb("global");
    const inputs = makeInMemoryDb("inputs");
    const revdeps = makeInMemoryDb("revdeps");
    const counters = makeInMemoryDb("counters");
    const timestamps = makeInMemoryDb("timestamps");

    return {
        values, freshness, global, inputs, revdeps, counters, timestamps,
        async batch(operations) {
            for (const op of operations) {
                values.apply(op);
                freshness.apply(op);
                global.apply(op);
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
        async getGlobalVersion() { return prevVersion; },
        getSchemaStorage() { return xStorage; },
        currentReplicaName() { return 'x'; },
        otherReplicaName() { return 'y'; },
        schemaStorageForReplica(name) { return name === 'x' ? xStorage : yStorage; },
        async clearReplicaStorage(_name) {},
        async setCurrentReplicaPointer(_name) {},
        async setGlobalVersion(_v) {},
        async _rawSync() {},
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
    mockCheckpointMigration.mockReset();
    mockCheckpointMigration.mockImplementation(async (_caps, _db, _pre, _post, callback) => await callback());
    capabilities.checkpointMigration = mockCheckpointMigration;
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

        await expect(yGet(yStorage.timestamps, yStorage, nodeKey)).resolves.toEqual(OLD_TIMESTAMP);
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

        const result = await yGet(yStorage.timestamps, yStorage, nodeKey);
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

        const result = await yGet(yStorage.timestamps, yStorage, nodeKey);
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

        await expect(yGet(yStorage.timestamps, yStorage, nodeKey)).resolves.toBeUndefined();
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

        await expect(yGet(yStorage.timestamps, yStorage, nkA)).resolves.toEqual(OLD_TIMESTAMP);
        await expect(yGet(yStorage.timestamps, yStorage, nkB)).resolves.toEqual(NEW_TIMESTAMP);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// override decision copies timestamps
// ─────────────────────────────────────────────────────────────────────────────

describe("override decision: timestamps copied to new storage", () => {
    test("modifiedAt is bumped to migration time; createdAt preserved", async () => {
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

        const result = await yGet(yStorage.timestamps, yStorage, nodeKey);
        expect(result.createdAt).toBe(OLD_TIMESTAMP.createdAt);
        expect(result.modifiedAt).toBe("2024-01-01T00:00:00.000Z");
    });

    test("override without previous timestamp writes new timestamp", async () => {
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

        const result = await yGet(yStorage.timestamps, yStorage, nodeKey);
        expect(result.createdAt).toBe("2024-01-01T00:00:00.000Z");
        expect(result.modifiedAt).toBe("2024-01-01T00:00:00.000Z");
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

        const result = await yGet(yStorage.timestamps, yStorage, nodeKey);
        expect(result.createdAt).toBe(ts.createdAt);
    });
});

// ---------------------------------------------------------------------------
// create decision writes timestamps
// ---------------------------------------------------------------------------

describe("create decision: timestamps written to new storage", () => {
    test("create writes createdAt and modifiedAt both set to migration time", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");

        const { rootDatabase } = makeRootDatabaseMock({
            prevVersion: "1", currentVersion: "2", xStorage, yStorage,
        });

        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A"]), async (storage) => {
            await storage.create(nodeKey, async () => ({ type: "all_events", events: [] }));
        });

        const allKeys = [];
        for await (const k of yStorage.timestamps.keys()) {
            allKeys.push(k);
        }
        expect(allKeys.length).toBeGreaterThanOrEqual(1);

        const result = await yGet(yStorage.timestamps, yStorage, nodeKey);
        expect(result).not.toBeUndefined();
        expect(result.createdAt).toBe("2024-01-01T00:00:00.000Z");
        expect(result.modifiedAt).toBe("2024-01-01T00:00:00.000Z");
    });
        expect(result.createdAt).toBe("2024-01-01T00:00:00.000Z");
        expect(result.modifiedAt).toBe("2024-01-01T00:00:00.000Z");
    });

    test("create node timestamp is defined (not undefined)", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");

        const { rootDatabase } = makeRootDatabaseMock({
            prevVersion: "1", currentVersion: "2", xStorage, yStorage,
        });

        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A"]), async (storage) => {
            await storage.create(nodeKey, async () => ({ type: "all_events", events: [] }));
        });

        const result = await yGet(yStorage.timestamps, yStorage, nodeKey);
        expect(result).not.toBeUndefined();
        expect(typeof result.createdAt).toBe("string");
        expect(typeof result.modifiedAt).toBe("string");
    });

    test("create multiple nodes: each gets fresh timestamps", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const nkA = toJsonKey("A");
        const nkB = toJsonKey("B");

        const { rootDatabase } = makeRootDatabaseMock({
            prevVersion: "1", currentVersion: "2", xStorage, yStorage,
        });

        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A", "B"]), async (storage) => {
            await storage.create(nkA, async () => ({ type: "all_events", events: [] }));
            await storage.create(nkB, async () => ({ type: "all_events", events: [] }));
        });

        const aResult = await yGet(yStorage.timestamps, yStorage, nkA);
        const bResult = await yGet(yStorage.timestamps, yStorage, nkB);
        expect(aResult.createdAt).toBe("2024-01-01T00:00:00.000Z");
        expect(aResult.modifiedAt).toBe("2024-01-01T00:00:00.000Z");
        expect(bResult.createdAt).toBe("2024-01-01T00:00:00.000Z");
        expect(bResult.modifiedAt).toBe("2024-01-01T00:00:00.000Z");
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

        await expect(yGet(yStorage.timestamps, yStorage, nodeKey)).resolves.toEqual(OLD_TIMESTAMP);
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

        await expect(yGet(yStorage.timestamps, yStorage, nodeKey)).resolves.toBeUndefined();
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

        const result = await yGet(yStorage.timestamps, yStorage, nodeKey);
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

        await expect(yGet(yStorage.timestamps, yStorage, nkA)).resolves.toBeUndefined();
        await expect(yGet(yStorage.timestamps, yStorage, nkB)).resolves.toBeUndefined();
    });
});

describe("delete decision: sublevels do not retain deleted keys", () => {
    test("deleted nodes are removed from inputs/counters/timestamps key lists", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const nkA = toJsonKey("A");
        const nkB = toJsonKey("B");

        await seedNode(xStorage, nkA, {
            timestamps: OLD_TIMESTAMP,
            inputs: [],
            inputCounters: [],
            counter: 11,
            freshness: "up-to-date",
        });
        await seedNode(xStorage, nkB, {
            timestamps: NEW_TIMESTAMP,
            inputs: [nkA],
            inputCounters: [1],
            counter: 22,
            freshness: "up-to-date",
        });
        await xStorage.revdeps.put(nkA, [nkB]);

        const { rootDatabase } = makeRootDatabaseMock({
            prevVersion: "1",
            currentVersion: "2",
            xStorage,
            yStorage,
        });

        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A", "B"]), async (storage) => {
            await storage.delete(nkA);
            await storage.delete(nkB);
        });

        const inputKeys = await collectKeys(yStorage.inputs);
        const counterKeys = await collectKeys(yStorage.counters);
        const timestampKeys = await collectKeys(yStorage.timestamps);

        expect(inputKeys).not.toContain(nkA);
        expect(inputKeys).not.toContain(nkB);
        expect(counterKeys).not.toContain(nkA);
        expect(counterKeys).not.toContain(nkB);
        expect(timestampKeys).not.toContain(nkA);
        expect(timestampKeys).not.toContain(nkB);
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

        await expect(yGet(yStorage.timestamps, yStorage, nkA)).resolves.toEqual(OLD_TIMESTAMP);
        await expect(yGet(yStorage.timestamps, yStorage, nkB)).resolves.toEqual(NEW_TIMESTAMP);
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

        await expect(yGet(yStorage.timestamps, yStorage, nkA)).resolves.toEqual(OLD_TIMESTAMP);
        await expect(yGet(yStorage.timestamps, yStorage, nkB)).resolves.toEqual(NEW_TIMESTAMP);
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

        await expect(yGet(yStorage.timestamps, yStorage, nkA)).resolves.toEqual(OLD_TIMESTAMP);
        const bResult = await yGet(yStorage.timestamps, yStorage, nkB);
        expect(bResult.createdAt).toBe(NEW_TIMESTAMP.createdAt);
    });

    test("override A, B auto-invalidated: A modifiedAt bumped, B timestamp preserved", async () => {
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

        const aResult = await yGet(yStorage.timestamps, yStorage, nkA);
        expect(aResult.createdAt).toBe(OLD_TIMESTAMP.createdAt);
        expect(aResult.modifiedAt).toBe("2024-01-01T00:00:00.000Z");
        await expect(yGet(yStorage.timestamps, yStorage, nkB)).resolves.toEqual(NEW_TIMESTAMP);
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

        await expect(yGet(yStorage.timestamps, yStorage, nkA)).resolves.toEqual(OLD_TIMESTAMP);
        await expect(yGet(yStorage.timestamps, yStorage, nkB)).resolves.toEqual(NEW_TIMESTAMP);
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
