/**
 * Tests that verify materialized-node timestamps during database migration.
 *
 * Migration produces total timestamp records over the materialized identifier
 * registry. Identity-preserving decisions (keep, replace, invalidate) preserve both `createdAt`
 * and `modifiedAt`; only decisions that create new entries (create) mint new timestamps.
 */

const { runMigration } = require("../src/generators/incremental_graph/migration_runner");
const { compileNodeDef } = require("../src/generators/incremental_graph/compiled_node");
const {
    IDENTIFIERS_KEY,
    LAST_NODE_INDEX_KEY,
    GRAPH_SCHEME_KEY,
    nodeIdentifierFromString,
    nodeIdentifierToString,
    buildGraphSchemeFromNodeDefs,
    serializeGraphScheme,
} = require("../src/generators/incremental_graph/database");
const { toJsonKey } = require("./test_json_key_helper");
const { deserializeNodeKey } = require("../src/generators/incremental_graph/database");
const {
    finalizeEmission,
    isValueEvent,
    makeJournalAuthor,
    nodeKeyToCanonicalString,
} = require("../src/generators/incremental_graph/journal");
const {
    appendJournalPublicationOps,
    makeInitialCommittedWriterState,
} = require("../src/generators/incremental_graph/journal_store");
const { fromISOString } = require("../src/datetime");
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

/**
 * Current-format NodeIdentifiers for the fixture nodes, and the node key each one
 * denotes. A replica's materialized nodes are addressed by identifier and the
 * identifier lookup maps them to their node keys, so a fixture which seeds a node
 * needs both.
 */
const FIXTURE_FINGERPRINT = "abcdefghi";
/** The fingerprint `makeRootDatabaseMock` reports, which is also the fixture writer. */
const TEST_FINGERPRINT = "testfingerprnt";
const fixtureIdentifiers = new Map();
/**
 * The direct input of each head in the linear chain `makeNodeDefs` builds, so a
 * seeded occurrence can be certified against the occurrence of its input.
 */
const fixtureInputHeadOf = new Map();
let nextFixtureIndex = 0;

/**
 * The current-format identifier of a fixture node, registering the node key it
 * denotes in the registry the storage doubles' identifier lookups serve.
 * @param {string} name - Node head, e.g. "A".
 * @returns {import('../src/generators/incremental_graph/database').NodeIdentifier}
 */
function fixtureIdentifier(name) {
    const existing = fixtureIdentifiers.get(name);
    if (existing !== undefined) {
        return existing;
    }
    nextFixtureIndex += 1;
    const identifier = nodeIdentifierFromString(`${nextFixtureIndex}-${FIXTURE_FINGERPRINT}`);
    fixtureIdentifiers.set(name, identifier);
    return identifier;
}

/** The node head a fixture identifier denotes. */
function fixtureHeadOf(identifier) {
    for (const [name, candidate] of fixtureIdentifiers) {
        if (nodeIdentifierToString(candidate) === nodeIdentifierToString(identifier)) {
            return name;
        }
    }
    throw new Error(`no fixture node is registered for ${nodeIdentifierToString(identifier)}`);
}

/** The node key a fixture identifier denotes. */
function fixtureNodeKey(identifier) {
    return toJsonKey(fixtureHeadOf(identifier));
}

function makeSchemaStorage() {
    const values = makeInMemoryDb("values");
    const freshness = makeInMemoryDb("freshness");
    const global = makeInMemoryDb("global");
    const valid = makeInMemoryDb("valid");
    const timestamps = makeInMemoryDb("timestamps");
    // A replica's journal is one of its sublevels: the migration cutover builds the
    // target's journal alongside the target's graph state, so the double carries one.
    const journal = makeInMemoryDb("journal");

    const originalGlobalGet = global.get.bind(global);
    global.get = async (key) => {
        if (key === IDENTIFIERS_KEY) {
            const stored = await originalGlobalGet(key);
            if (stored !== undefined) return stored;
            const out = [];
            for await (const k of values.keys()) {
                out.push([nodeIdentifierToString(k), fixtureNodeKey(k)]);
            }
            return out;
        }
        if (key === LAST_NODE_INDEX_KEY) {
            const stored = await originalGlobalGet(key);
            if (stored !== undefined) return stored;
            return 0;
        }
        return await originalGlobalGet(key);
    };

    return {
        values, freshness, global, valid, timestamps, journal,
        /**
         * The writer state and occurrence ids the fixture's own publications
         * reached, so a replica double threads its own Journal the way a replica
         * does. A replica which wrote a value into the graph without the record
         * explaining it is a replica whose graph is not a projection of its
         * Journal.
         * @type {import('../src/generators/incremental_graph/journal/emission').CommittedWriterState | undefined}
         */
        fixtureWriterState: undefined,
        /** @type {Map<string, import('../src/generators/incremental_graph/journal/types').JournalRecordId>} */
        fixtureValueIds: new Map(),
        async batch(operations) {
            for (const op of operations) {
                values.apply(op);
                freshness.apply(op);
                global.apply(op);
                valid.apply(op);
                timestamps.apply(op);
                journal.apply(op);
            }
        },
    };
}

function makeRootDatabaseMock({ prevVersion, currentVersion, xStorage, yStorage }) {
    const rootDatabase = {
        version: currentVersion,
        _computed: { lastNodeIndex: 0, fingerprint: "testfingerprnt" },
        getFingerprint() { return "testfingerprnt"; },
        getVersion() { return this.version; },
        getLastNodeIndex() { return this._computed.lastNodeIndex; },
        advanceLastNodeIndex(value) { this._computed.lastNodeIndex = Math.max(this._computed.lastNodeIndex, value); },
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

/**
 * The migration publication/finalization physical time of every cutover in this
 * file. `stubDatetime` pins the clock here, and §11a.3 makes it the `modifiedAt` of
 * every occurrence a migration genuinely produces.
 */
const PUBLICATION_INSTANT = "2024-01-01T00:00:00.000Z";

/** Build a minimal single-node NodeDef array for node "A". */
function makeNodeDefs(names) {
    for (let index = 1; index < names.length; index += 1) {
        fixtureInputHeadOf.set(names[index], names[index - 1]);
    }
    return names.map((name, idx, arr) => ({
        output: name,
        inputs: idx > 0 ? [arr[idx - 1]] : [],
        computor: async () => ({ type: "all_events", events: [] }),
        isDeterministic: true,
        hasSideEffects: false,
    }));
}

/** Seed a node in storage with value, freshness, and optional timestamps. */
async function seedNode(storage, nodeKey, {
    timestamps = undefined,
    freshness = "up-to-date",
} = {}) {
    await storage.values.put(nodeKey, { type: "all_events", events: [] });
    await storage.freshness.put(nodeKey, freshness);
    if (timestamps !== undefined) {
        await storage.timestamps.put(nodeKey, timestamps);
    }
    if (timestamps !== undefined) {
        await publishFixtureOccurrence(storage, nodeKey, timestamps);
    }
}

/**
 * The local writer every fixture replica publishes as. It is the fingerprint
 * `makeRootDatabaseMock` reports, so the occurrences a fixture replica retains are
 * its own writer's.
 */
function fixtureLocalWriter() {
    const localWriter = makeJournalAuthor(TEST_FINGERPRINT);
    if (localWriter instanceof Error) {
        throw new Error("the fixture fingerprint is not a valid writer name: " + localWriter.message);
    }
    return localWriter;
}

/**
 * Publish the ordinary occurrence a seeded node's graph state is a projection of.
 *
 * A replica's graph is `project(Journal)`, so a fixture which writes a value
 * directly into the graph without the record explaining it is a replica whose two
 * representations disagree. The migration cutover verifies that agreement on the
 * target it builds, so the source fixtures carry their occurrences too.
 *
 * @param {ReturnType<typeof makeSchemaStorage>} storage
 * @param {import('../src/generators/incremental_graph/database').NodeIdentifier} nodeIdentifier
 * @param {{createdAt: string, modifiedAt: string}} timestamps
 * @returns {Promise<void>}
 */
async function publishFixtureOccurrence(storage, nodeIdentifier, timestamps) {
    const head = fixtureHeadOf(nodeIdentifier);
    const inputHead = fixtureInputHeadOf.get(head);
    /** @type {Array<import('../src/generators/incremental_graph/journal/emission').MaterializeInput>} */
    const inputs = [];
    if (inputHead !== undefined) {
        const inputIdentifier = fixtureIdentifiers.get(inputHead);
        const inputKeyString = inputIdentifier === undefined
            ? undefined
            : String(fixtureNodeKey(inputIdentifier));
        const valueId = inputKeyString === undefined
            ? undefined
            : storage.fixtureValueIds.get(inputKeyString);
        if (inputIdentifier === undefined || inputKeyString === undefined || valueId === undefined) {
            throw new Error(`the fixture input ${inputHead} must be published before ${head}`);
        }
        inputs.push({ input: fixtureNodeKeyObject(inputIdentifier), value: valueId });
    }
    const initial = makeInitialCommittedWriterState(fixtureLocalWriter());
    if (initial instanceof Error) {
        throw new Error("the fixture writer state is malformed: " + initial.message);
    }
    const state = storage.fixtureWriterState === undefined ? initial : storage.fixtureWriterState;
    const publication = finalizeEmission({
        state,
        intents: [{
            kind: "materialize",
            node: fixtureNodeKeyObject(nodeIdentifier),
            nodeIdentifier,
            payload: { type: "all_events", events: [] },
            createdAt: timestamps.createdAt,
            modifiedAt: timestamps.modifiedAt,
            inputs,
        }],
        publicationInstant: fromISOString(timestamps.modifiedAt).toMillis(),
        allocatorWatermark: storage.fixtureValueIds.size + 1,
    });
    if (publication instanceof Error) {
        throw new Error("the fixture occurrence was rejected: " + publication.message);
    }
    /** @type {Array<import('../src/generators/incremental_graph/database/root_database').DatabaseBatchOperation>} */
    const operations = [];
    const rejected = appendJournalPublicationOps(storage.journal, operations, publication);
    if (rejected !== undefined) {
        throw new Error("the fixture occurrence could not be appended: " + rejected.message);
    }
    await storage.batch(operations);
    storage.fixtureWriterState = publication.writerState;
    for (const record of publication.records) {
        if (isValueEvent(record)) {
            storage.fixtureValueIds.set(nodeKeyToCanonicalString(record.node), record.id);
        }
    }
}

/** The node key a fixture identifier denotes, as the `NodeKey` a record names. */
function fixtureNodeKeyObject(nodeIdentifier) {
    return deserializeNodeKey(String(fixtureNodeKey(nodeIdentifier)));
}


/**
 * Seed the stored graph scheme required by versioned migration sources.
 * @param {ReturnType<typeof makeSchemaStorage>} storage
 * @param {ReturnType<typeof makeNodeDefs>} nodeDefs
 */
async function seedGraphScheme(storage, nodeDefs) {
    const compiledNodes = nodeDefs.map(compileNodeDef);
    const scheme = serializeGraphScheme(buildGraphSchemeFromNodeDefs(compiledNodes));
    await storage.global.put(GRAPH_SCHEME_KEY, JSON.stringify(scheme));
}

// ─────────────────────────────────────────────────────────────────────────────
// keep decision copies timestamps
// ─────────────────────────────────────────────────────────────────────────────

describe("keep decision: timestamps copied to new storage", () => {
    test("both createdAt and modifiedAt are identical in new storage after keep", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const nodeKey = fixtureIdentifier("A");

        await seedNode(xStorage, nodeKey, { timestamps: OLD_TIMESTAMP });
        const { rootDatabase } = makeRootDatabaseMock({
            prevVersion: "1", currentVersion: "2", xStorage, yStorage,
        });

        await seedGraphScheme(xStorage, makeNodeDefs(["A"]));
        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A"]), async (storage) => {
            await storage.keep(nodeKey);
        });

        await expect(yGet(yStorage.timestamps, yStorage, nodeKey)).resolves.toEqual(OLD_TIMESTAMP);
    });

    test("createdAt is preserved exactly after keep", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const nodeKey = fixtureIdentifier("A");

        await seedNode(xStorage, nodeKey, { timestamps: OLD_TIMESTAMP });
        const { rootDatabase } = makeRootDatabaseMock({
            prevVersion: "1", currentVersion: "2", xStorage, yStorage,
        });

        await seedGraphScheme(xStorage, makeNodeDefs(["A"]));
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
        const nodeKey = fixtureIdentifier("A");

        await seedNode(xStorage, nodeKey, { timestamps: OLD_TIMESTAMP });
        const { rootDatabase } = makeRootDatabaseMock({
            prevVersion: "1", currentVersion: "2", xStorage, yStorage,
        });

        await seedGraphScheme(xStorage, makeNodeDefs(["A"]));
        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A"]), async (storage) => {
            await storage.keep(nodeKey);
        });

        const result = await yGet(yStorage.timestamps, yStorage, nodeKey);
        expect(result.modifiedAt).toBe(OLD_TIMESTAMP.modifiedAt);
    });

    test("node with no previous timestamp after keep fails final validation", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const nodeKey = fixtureIdentifier("A");

        await seedNode(xStorage, nodeKey); // no timestamps
        const { rootDatabase } = makeRootDatabaseMock({
            prevVersion: "1", currentVersion: "2", xStorage, yStorage,
        });

        await seedGraphScheme(xStorage, makeNodeDefs(["A"]));
        await expect(runMigration(capabilities, rootDatabase, makeNodeDefs(["A"]), async (storage) => {
            await storage.keep(nodeKey);
        })).rejects.toThrow("has no timestamps entry");
    });

    test("multiple nodes: all timestamps copied correctly on keep", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const nkA = fixtureIdentifier("A");
        const nkB = fixtureIdentifier("B");

        await seedNode(xStorage, nkA, { timestamps: OLD_TIMESTAMP });
        await seedNode(xStorage, nkB, {
            timestamps: NEW_TIMESTAMP,
            inputs: [nkA],
        });
        await xStorage.valid.put(nkA, [nkB]);
        const { rootDatabase } = makeRootDatabaseMock({
            prevVersion: "1", currentVersion: "2", xStorage, yStorage,
        });

        await seedGraphScheme(xStorage, makeNodeDefs(["A", "B"]));
        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A", "B"]), async (storage) => {
            await storage.keep(nkA);
            await storage.keep(nkB);
        });

        await expect(yGet(yStorage.timestamps, yStorage, nkA)).resolves.toEqual(OLD_TIMESTAMP);
        await expect(yGet(yStorage.timestamps, yStorage, nkB)).resolves.toEqual(NEW_TIMESTAMP);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// replacement decision: §11a.3 timestamps
// ─────────────────────────────────────────────────────────────────────────────

describe("replacement decision: §11a.3 occurrence timestamps", () => {
    test("a replacement preserves createdAt and takes the publication time as modifiedAt", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const nodeKey = fixtureIdentifier("A");

        await seedNode(xStorage, nodeKey, { timestamps: OLD_TIMESTAMP });
        const { rootDatabase } = makeRootDatabaseMock({
            prevVersion: "1", currentVersion: "2", xStorage, yStorage,
        });

        await seedGraphScheme(xStorage, makeNodeDefs(["A"]));
        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A"]), async (storage) => {
            await storage.replace(nodeKey, async () => ({ type: "all_events", events: [] }));
        });

        const result = await yGet(yStorage.timestamps, yStorage, nodeKey);
        expect(result.createdAt).toBe(OLD_TIMESTAMP.createdAt);
        expect(result.modifiedAt).toBe(PUBLICATION_INSTANT);
    });

    test("migration source without previous timestamp is rejected", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const nodeKey = fixtureIdentifier("A");

        await seedNode(xStorage, nodeKey); // no timestamps
        const { rootDatabase } = makeRootDatabaseMock({
            prevVersion: "1", currentVersion: "2", xStorage, yStorage,
        });

        await seedGraphScheme(xStorage, makeNodeDefs(["A"]));
        await expect(runMigration(capabilities, rootDatabase, makeNodeDefs(["A"]), async (storage) => {
            await storage.replace(nodeKey, async () => ({ type: "all_events", events: [] }));
        })).rejects.toThrow("has no timestamps entry");
    });

    test("a replacement takes the publication time even when the source stamps differ", async () => {
        const capabilities = await getTestCapabilities();
        const ts = { createdAt: "2023-05-01T00:00:00.000Z", modifiedAt: "2024-11-30T23:59:59.000Z" };
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const nodeKey = fixtureIdentifier("A");

        await seedNode(xStorage, nodeKey, { timestamps: ts });
        const { rootDatabase } = makeRootDatabaseMock({
            prevVersion: "1", currentVersion: "2", xStorage, yStorage,
        });

        await seedGraphScheme(xStorage, makeNodeDefs(["A"]));
        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A"]), async (storage) => {
            await storage.replace(nodeKey, async () => ({ type: "all_events", events: [] }));
        });

        const result = await yGet(yStorage.timestamps, yStorage, nodeKey);
        expect(result.createdAt).toBe(ts.createdAt);
        expect(result.modifiedAt).toBe(PUBLICATION_INSTANT);
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

        await seedGraphScheme(xStorage, makeNodeDefs(["A"]));
        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A"]), async (storage) => {
            await storage.create(toJsonKey("A"), async () => ({ type: "all_events", events: [] }), "up-to-date");
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

    test("create node timestamp is defined (not undefined)", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const nodeKey = toJsonKey("A");

        const { rootDatabase } = makeRootDatabaseMock({
            prevVersion: "1", currentVersion: "2", xStorage, yStorage,
        });

        await seedGraphScheme(xStorage, makeNodeDefs(["A"]));
        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A"]), async (storage) => {
            await storage.create(toJsonKey("A"), async () => ({ type: "all_events", events: [] }), "up-to-date");
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

        await seedGraphScheme(xStorage, makeNodeDefs(["A", "B"]));
        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A", "B"]), async (storage) => {
            await storage.create(toJsonKey("A"), async () => ({ type: "all_events", events: [] }), "up-to-date");
            await storage.create(toJsonKey("B"), async () => ({ type: "all_events", events: [] }), "up-to-date");
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
// invalidate decision preserves timestamps
// ─────────────────────────────────────────────────────────────────────────────

describe("invalidate decision: timestamps preserved", () => {
    test("invalidation preserves both createdAt and modifiedAt", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const nodeKey = fixtureIdentifier("A");

        await seedNode(xStorage, nodeKey, { timestamps: OLD_TIMESTAMP });
        const { rootDatabase } = makeRootDatabaseMock({
            prevVersion: "1", currentVersion: "2", xStorage, yStorage,
        });

        await seedGraphScheme(xStorage, makeNodeDefs(["A"]));
        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A"]), async (storage) => {
            await storage.invalidate(nodeKey);
        });

        await expect(yGet(yStorage.timestamps, yStorage, nodeKey)).resolves.toEqual(OLD_TIMESTAMP);
    });

    test("invalidate without previous timestamp fails final validation", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const nodeKey = fixtureIdentifier("A");

        await seedNode(xStorage, nodeKey); // no timestamps
        const { rootDatabase } = makeRootDatabaseMock({
            prevVersion: "1", currentVersion: "2", xStorage, yStorage,
        });

        await seedGraphScheme(xStorage, makeNodeDefs(["A"]));
        await expect(runMigration(capabilities, rootDatabase, makeNodeDefs(["A"]), async (storage) => {
            await storage.invalidate(nodeKey);
        })).rejects.toThrow("has no timestamps entry");
    });

    test("invalidation preserves both createdAt and modifiedAt when value is stale", async () => {
        const capabilities = await getTestCapabilities();
        const ts = { createdAt: "2022-01-01T00:00:00.000Z", modifiedAt: "2022-01-01T00:00:00.000Z" };
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const nodeKey = fixtureIdentifier("A");

        await seedNode(xStorage, nodeKey, { timestamps: ts, freshness: "up-to-date" });
        const { rootDatabase } = makeRootDatabaseMock({
            prevVersion: "1", currentVersion: "2", xStorage, yStorage,
        });

        await seedGraphScheme(xStorage, makeNodeDefs(["A"]));
        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A"]), async (storage) => {
            await storage.invalidate(nodeKey);
        });

        const result = await yGet(yStorage.timestamps, yStorage, nodeKey);
        expect(result.createdAt).toBe(ts.createdAt);
        expect(result.modifiedAt).toBe(ts.modifiedAt);
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
        const nkA = fixtureIdentifier("A");
        const nkB = fixtureIdentifier("B");

        await seedNode(xStorage, nkA, { timestamps: OLD_TIMESTAMP });
        await seedNode(xStorage, nkB, {
            timestamps: NEW_TIMESTAMP,
            inputs: [nkA],
        });
        await xStorage.valid.put(nkA, [nkB]);
        const { rootDatabase } = makeRootDatabaseMock({
            prevVersion: "1", currentVersion: "2", xStorage, yStorage,
        });

        // Deleting both; B auto-deleted because A is deleted (fan-out propagation)
        await seedGraphScheme(xStorage, makeNodeDefs(["A", "B"]));
        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A", "B"]), async (storage) => {
            await storage.delete(nkA);
            await storage.delete(nkB);
        });

        await expect(yGet(yStorage.timestamps, yStorage, nkA)).resolves.toBeUndefined();
        await expect(yGet(yStorage.timestamps, yStorage, nkB)).resolves.toBeUndefined();
    });
});

describe("delete decision: sublevels do not retain deleted keys", () => {
    test("deleted nodes are removed from inputs/timestamps key lists", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const nkA = fixtureIdentifier("A");
        const nkB = fixtureIdentifier("B");

        await seedNode(xStorage, nkA, {
            timestamps: OLD_TIMESTAMP,
            freshness: "up-to-date",
        });
        await seedNode(xStorage, nkB, {
            timestamps: NEW_TIMESTAMP,
            freshness: "up-to-date",
        });
        await xStorage.valid.put(nkA, [nkB]);

        const { rootDatabase } = makeRootDatabaseMock({
            prevVersion: "1",
            currentVersion: "2",
            xStorage,
            yStorage,
        });

        await seedGraphScheme(xStorage, makeNodeDefs(["A", "B"]));
        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A", "B"]), async (storage) => {
            await storage.delete(nkA);
            await storage.delete(nkB);
        });

        const timestampKeys = await collectKeys(yStorage.timestamps);

        expect(timestampKeys).not.toContain(nkA);
        expect(timestampKeys).not.toContain(nkB);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Two-node chain: independent decision combinations
// ─────────────────────────────────────────────────────────────────────────────

describe("two-node chain: mixed decision timestamp behaviour", () => {
    async function buildChain(xStorage) {
        const nkA = fixtureIdentifier("A");
        const nkB = fixtureIdentifier("B");
        await seedNode(xStorage, nkA, { timestamps: OLD_TIMESTAMP });
        await seedNode(xStorage, nkB, {
            timestamps: NEW_TIMESTAMP,
        });
        await xStorage.valid.put(nkA, [nkB]);
        return { nkA, nkB };
    }

    test("keep A, keep B: both timestamps preserved", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const { nkA, nkB } = await buildChain(xStorage);
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yStorage });

        await seedGraphScheme(xStorage, makeNodeDefs(["A", "B"]));
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

        await seedGraphScheme(xStorage, makeNodeDefs(["A", "B"]));
        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A", "B"]), async (storage) => {
            await storage.keep(nkA);
            await storage.invalidate(nkB);
        });

        await expect(yGet(yStorage.timestamps, yStorage, nkA)).resolves.toEqual(OLD_TIMESTAMP);
        await expect(yGet(yStorage.timestamps, yStorage, nkB)).resolves.toEqual(NEW_TIMESTAMP);
    });

    test("keep A, replace B: A keeps both stamps, B takes the publication time", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const { nkA, nkB } = await buildChain(xStorage);
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yStorage });

        await seedGraphScheme(xStorage, makeNodeDefs(["A", "B"]));
        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A", "B"]), async (storage) => {
            await storage.keep(nkA);
            await storage.replace(nkB, async () => ({ type: "all_events", events: [] }));
        });

        await expect(yGet(yStorage.timestamps, yStorage, nkA)).resolves.toEqual(OLD_TIMESTAMP);
        await expect(yGet(yStorage.timestamps, yStorage, nkB)).resolves.toEqual({
            createdAt: NEW_TIMESTAMP.createdAt,
            modifiedAt: PUBLICATION_INSTANT,
        });
    });

    test("replace A requires an explicit decision for B", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const { nkA } = await buildChain(xStorage);
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yStorage });

        await seedGraphScheme(xStorage, makeNodeDefs(["A", "B"]));
        await expect(runMigration(capabilities, rootDatabase, makeNodeDefs(["A", "B"]), async (storage) => {
            await storage.replace(nkA, async () => ({ type: "all_events", events: [] }));
        })).rejects.toThrow("have no decision");
    });

    test("invalidate A, invalidate B: both timestamps preserved", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const { nkA, nkB } = await buildChain(xStorage);
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yStorage });

        await seedGraphScheme(xStorage, makeNodeDefs(["A", "B"]));
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
        const nodeKey = fixtureIdentifier("A");

        await seedNode(xStorage, nodeKey, { timestamps: OLD_TIMESTAMP });
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yStorage });

        await seedGraphScheme(xStorage, makeNodeDefs(["A"]));
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
        const nkA = fixtureIdentifier("A");
        const nkB = fixtureIdentifier("B");

        await seedNode(xStorage, nkA, { timestamps: OLD_TIMESTAMP });
        await seedNode(xStorage, nkB, { timestamps: NEW_TIMESTAMP });
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "v1", currentVersion: "v2", xStorage, yStorage });

        await seedGraphScheme(xStorage, makeNodeDefs(["A", "B"]));
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
