/**
 * The canonical Journal migration chain of
 * `docs/specs/incremental-graph-journal-migrations.md` §9b.
 *
 * Per-edge codec determinism is not enough when a replica can reach the same
 * target version through different version paths: immutable retained records
 * keep their `JournalRecordId`, so every supported upgrade from one Journal
 * version to another has exactly one canonical transition sequence. A machine
 * may skip application releases, but it does not skip canonical Journal
 * migration transitions — each chain step is a complete migration with a
 * version cut to that intermediate version, and a stored version with no
 * complete canonical chain to the running version fails
 * `JournalVersionCompatibilityError`.
 */

const { runMigration } = require("../src/generators/incremental_graph/migration_runner");
const { compileNodeDef } = require("../src/generators/incremental_graph/compiled_node");
const {
    IDENTIFIERS_KEY,
    LAST_NODE_INDEX_KEY,
    GRAPH_SCHEME_KEY,
    nodeIdentifierToString,
    buildGraphSchemeFromNodeDefs,
    serializeGraphScheme,
    nodeIdentifierFromString,
    deserializeNodeKey,
} = require("../src/generators/incremental_graph/database");
const {
    makeIdentityJournalFormatCodec,
    makeJournalFormatCodec,
} = require("../src/generators/incremental_graph/migration_codec");
const {
    makeCanonicalMigrationChain,
    canonicalNextJournalVersion,
    resolveCanonicalMigrationChain,
} = require("../src/generators/incremental_graph/journal_migration_chain");
const {
    isJournalVersionCompatibilityError,
    makeJournalAuthor,
    finalizeEmission,
} = require("../src/generators/incremental_graph/journal");
const {
    appendJournalPublicationOps,
    makeInitialCommittedWriterState,
} = require("../src/generators/incremental_graph/journal_store");
const { fromISOString } = require("../src/datetime");
const { toJsonKey } = require("./test_json_key_helper");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger, stubDatetime, stubEnvironment } = require("./stubs");
jest.mock('../src/generators/incremental_graph/database', () => ({
    ...jest.requireActual('../src/generators/incremental_graph/database'),
    checkpointMigration: jest.fn(),
}));
const { checkpointMigration: mockCheckpointMigration } = require('../src/generators/incremental_graph/database');

jest.mock('../src/generators/incremental_graph/database/sync_merge_validation', () => ({
    ...jest.requireActual('../src/generators/incremental_graph/database/sync_merge_validation'),
    assertValidFinalMergeState: jest.fn(),
    assertValidReplicaMaterializationState: jest.fn(),
}));

const FIXTURE_FINGERPRINT = "testchainfinprnt";

/**
 * The fixture materialization of a node head. Each distinct head gets one
 * identifier, so a schema with several heads materializes distinct nodes.
 * @type {Map<string, import('../src/generators/incremental_graph/database').NodeIdentifier>}
 */
const fixtureIdentifiersByHead = new Map();

/**
 * The fixture materialization of a node head.
 * @param {string} name
 * @returns {import('../src/generators/incremental_graph/database').NodeIdentifier}
 */
function fixtureNode(name) {
    const existing = fixtureIdentifiersByHead.get(name);
    if (existing !== undefined) {
        return existing;
    }
    const identifier = nodeIdentifierFromString(
        `${fixtureIdentifiersByHead.size + 1}-${FIXTURE_FINGERPRINT}`
    );
    fixtureIdentifiersByHead.set(name, identifier);
    return identifier;
}

/**
 * The semantic node key a fixture materialization denotes.
 * @param {import('../src/generators/incremental_graph/database').NodeIdentifier} identifier
 * @returns {string}
 */
function nodeKeyOf(identifier) {
    const identifierString = nodeIdentifierToString(identifier);
    for (const [name, candidate] of fixtureIdentifiersByHead) {
        if (nodeIdentifierToString(candidate) === identifierString) {
            return toJsonKey(name);
        }
    }
    throw new Error(`no fixture head is registered for ${identifierString}`);
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
    const valid = makeInMemoryDb("valid");
    const timestamps = makeInMemoryDb("timestamps");
    const journal = makeInMemoryDb("journal");
    return {
        values, freshness, global, valid, timestamps, journal,
        fixtureWriterState: undefined,
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

/**
 * Seed a node into storage with value, freshness, timestamps, and a Journal
 * occurrence so the migration's target verification can replay it.
 * @param {import('../src/generators/incremental_graph/database').SchemaStorage} storage
 * @param {import('../src/generators/incremental_graph/database').NodeIdentifier} nodeIdentifier
 */
async function seedNode(storage, nodeIdentifier) {
    const key = nodeIdentifier;
    await storage.values.put(key, { type: "all_events", events: [] });
    await storage.freshness.put(key, "up-to-date");
    const timestamps = { createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-01T00:00:00.000Z" };
    await storage.timestamps.put(key, timestamps);
    const localWriter = makeJournalAuthor(FIXTURE_FINGERPRINT);
    if (localWriter instanceof Error) {
        throw new Error("the fixture fingerprint is not a valid writer name: " + localWriter.message);
    }
    const initial = makeInitialCommittedWriterState(localWriter);
    if (initial instanceof Error) {
        throw new Error("the fixture writer state is malformed: " + initial.message);
    }
    const publication = finalizeEmission({
        state: initial,
        intents: [{
            kind: "materialize",
            node: deserializeNodeKey(nodeKeyOf(nodeIdentifier)),
            nodeIdentifier,
            payload: { type: "all_events", events: [] },
            createdAt: timestamps.createdAt,
            modifiedAt: timestamps.modifiedAt,
            inputs: [],
        }],
        publicationInstant: fromISOString(timestamps.modifiedAt).toMillis(),
        allocatorWatermark: 1,
    });
    if (publication instanceof Error) {
        throw new Error("the fixture occurrence was rejected: " + publication.message);
    }
    const operations = [];
    const rejected = appendJournalPublicationOps(storage.journal, operations, publication);
    if (rejected !== undefined) {
        throw new Error("the fixture occurrence could not be appended: " + rejected.message);
    }
    await storage.batch(operations);
}

async function seedGraphScheme(storage, nodeDefs) {
    const compiledNodes = nodeDefs.map(compileNodeDef);
    const scheme = serializeGraphScheme(buildGraphSchemeFromNodeDefs(compiledNodes));
    await storage.global.put(GRAPH_SCHEME_KEY, JSON.stringify(scheme));
    const identifiers = nodeDefs.map(def => [fixtureNode(def.output), toJsonKey(def.output)]);
    await storage.global.put(IDENTIFIERS_KEY, identifiers);
    await storage.global.put(LAST_NODE_INDEX_KEY, 0);
}

/**
 * A rootDatabase double whose active replica follows cutovers, so a multi-edge
 * chain re-reads the stored version from the replica each cut selects.
 * @param {object} opts
 * @param {string} opts.currentVersion
 * @param {object} opts.xStorage
 * @param {object} opts.yStorage
 * @returns {{ rootDatabase: any, activeReplicaName: () => string }}
 */
function makeVersionAwareRootDatabaseMock({ currentVersion, xStorage, yStorage }) {
    let active = 'x';
    const storageFor = (name) => (name === 'x' ? xStorage : yStorage);
    const rootDatabase = {
        version: currentVersion,
        async getGlobalVersion() { return storageFor(active).global.get('version'); },
        getSchemaStorage() { return storageFor(active); },
        currentReplicaName() { return active; },
        otherReplicaName() { return active === 'x' ? 'y' : 'x'; },
        schemaStorageForReplica(name) { return storageFor(name); },
        async setCurrentReplicaPointer(name) { active = name; },
        async _rawSync() {},
        getFingerprint() { return FIXTURE_FINGERPRINT; },
        getVersion() { return currentVersion; },
    };
    return { rootDatabase, activeReplicaName: () => active };
}

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

const NODE_DEFS = [{
    output: "A",
    inputs: [],
    computor: async () => ({ type: "all_events", events: [] }),
    isDeterministic: true,
    hasSideEffects: false,
}];

/**
 * The source schema of a two-step representation chain: the replica starts with
 * the single materialized head `A`.
 */
const CHAIN_CODEC_SOURCE_NODE_DEFS = [{
    output: "A",
    inputs: [],
    computor: async () => ({ type: "all_events", events: [] }),
    isDeterministic: true,
    hasSideEffects: false,
}];

/**
 * The target schema of a two-step representation chain: the codec of the first
 * edge rewrites `A` to `A2`, the codec of the second edge rewrites `A2` to
 * `A23`, so the target schema must declare both transported heads.
 */
const CHAIN_CODEC_NODE_DEFS = [
    {
        output: "A2",
        inputs: [],
        computor: async () => ({ type: "all_events", events: [] }),
        isDeterministic: true,
        hasSideEffects: false,
    },
    {
        output: "A23",
        inputs: [],
        computor: async () => ({ type: "all_events", events: [] }),
        isDeterministic: true,
        hasSideEffects: false,
    },
];

describe("makeCanonicalMigrationChain", () => {
    test("builds a registry from a valid edge list", () => {
        const chain = makeCanonicalMigrationChain([
            { sourceVersion: "v1", targetVersion: "v2", codec: makeIdentityJournalFormatCodec(), callback: async () => {} },
            { sourceVersion: "v2", targetVersion: "v3", codec: makeIdentityJournalFormatCodec(), callback: async () => {} },
        ]);
        expect(isJournalVersionCompatibilityError(chain)).toBe(false);
        if (isJournalVersionCompatibilityError(chain)) {
            return;
        }
        expect(canonicalNextJournalVersion(chain, "v1")).toBe("v2");
        expect(canonicalNextJournalVersion(chain, "v2")).toBe("v3");
        expect(canonicalNextJournalVersion(chain, "v3")).toBeUndefined();
    });

    test("rejects a duplicate source version", () => {
        const chain = makeCanonicalMigrationChain([
            { sourceVersion: "v1", targetVersion: "v2", codec: makeIdentityJournalFormatCodec(), callback: async () => {} },
            { sourceVersion: "v1", targetVersion: "v3", codec: makeIdentityJournalFormatCodec(), callback: async () => {} },
        ]);
        expect(isJournalVersionCompatibilityError(chain)).toBe(true);
    });

    test("rejects a self-loop", () => {
        const chain = makeCanonicalMigrationChain([
            { sourceVersion: "v1", targetVersion: "v1", codec: makeIdentityJournalFormatCodec(), callback: async () => {} },
        ]);
        expect(isJournalVersionCompatibilityError(chain)).toBe(true);
    });

    test("rejects a cycle", () => {
        const chain = makeCanonicalMigrationChain([
            { sourceVersion: "v1", targetVersion: "v2", codec: makeIdentityJournalFormatCodec(), callback: async () => {} },
            { sourceVersion: "v2", targetVersion: "v1", codec: makeIdentityJournalFormatCodec(), callback: async () => {} },
        ]);
        expect(isJournalVersionCompatibilityError(chain)).toBe(true);
    });
});

describe("resolveCanonicalMigrationChain", () => {
    /**
     * @param {Array<[string, string]>} pairs
     * @returns {import('../src/generators/incremental_graph/journal_migration_chain').CanonicalMigrationChain}
     */
    function chainOf(pairs) {
        const chain = makeCanonicalMigrationChain(
            pairs.map(([sourceVersion, targetVersion]) => ({
                sourceVersion,
                targetVersion,
                codec: makeIdentityJournalFormatCodec(),
                callback: async () => {},
            }))
        );
        if (isJournalVersionCompatibilityError(chain)) {
            throw chain;
        }
        return chain;
    }

    test("a stored version equal to the running version resolves to an empty chain", () => {
        const chain = chainOf([["v1", "v2"]]);
        const resolved = resolveCanonicalMigrationChain(chain, "v2", "v2");
        expect(isJournalVersionCompatibilityError(resolved)).toBe(false);
        if (isJournalVersionCompatibilityError(resolved)) {
            return;
        }
        expect(resolved.edges).toEqual([]);
    });

    test("a one-edge chain resolves to that edge", () => {
        const chain = chainOf([["v1", "v2"]]);
        const resolved = resolveCanonicalMigrationChain(chain, "v1", "v2");
        expect(isJournalVersionCompatibilityError(resolved)).toBe(false);
        if (isJournalVersionCompatibilityError(resolved)) {
            return;
        }
        expect(resolved.edges.map((edge) => [edge.sourceVersion, edge.targetVersion])).toEqual([["v1", "v2"]]);
    });

    test("a multi-edge chain resolves to every edge in order", () => {
        const chain = chainOf([["v1", "v2"], ["v2", "v3"], ["v3", "v4"]]);
        const resolved = resolveCanonicalMigrationChain(chain, "v1", "v4");
        expect(isJournalVersionCompatibilityError(resolved)).toBe(false);
        if (isJournalVersionCompatibilityError(resolved)) {
            return;
        }
        expect(resolved.edges.map((edge) => [edge.sourceVersion, edge.targetVersion])).toEqual([
            ["v1", "v2"],
            ["v2", "v3"],
            ["v3", "v4"],
        ]);
    });

    test("a stored version with no canonical successor fails compatibility", () => {
        const chain = chainOf([["v1", "v2"]]);
        const resolved = resolveCanonicalMigrationChain(chain, "v1", "v3");
        expect(isJournalVersionCompatibilityError(resolved)).toBe(true);
    });

    test("an unregistered stored version fails compatibility", () => {
        const chain = chainOf([["v1", "v2"]]);
        const resolved = resolveCanonicalMigrationChain(chain, "v0", "v2");
        expect(isJournalVersionCompatibilityError(resolved)).toBe(true);
    });
});

describe("runMigration with a canonical chain", () => {
    test("executes each canonical edge stepwise and cuts over through every intermediate version", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const nodeKey = fixtureNode("A");
        await seedNode(xStorage, nodeKey);
        await seedGraphScheme(xStorage, NODE_DEFS);
        await xStorage.global.put("version", "v1");

        const mock = makeVersionAwareRootDatabaseMock({
            currentVersion: "v3",
            xStorage,
            yStorage,
        });

        /** @type {string[]} */
        const callbackLog = [];
        /**
         * @param {string} edge
         * @returns {(storage: import('../src/generators/incremental_graph/migration_storage').MigrationStorage) => Promise<void>}
         */
        const makeCallback = (edge) => async (storage) => {
            callbackLog.push(edge);
            for await (const identifier of storage.listMaterializedNodes()) {
                await storage.keep(identifier);
            }
        };

        const chain = makeCanonicalMigrationChain([
            { sourceVersion: "v1", targetVersion: "v2", codec: makeIdentityJournalFormatCodec(), callback: makeCallback("v1->v2") },
            { sourceVersion: "v2", targetVersion: "v3", codec: makeIdentityJournalFormatCodec(), callback: makeCallback("v2->v3") },
        ]);
        if (isJournalVersionCompatibilityError(chain)) {
            throw chain;
        }

        await runMigration(capabilities, mock.rootDatabase, NODE_DEFS, async () => {}, undefined, chain);

        expect(callbackLog).toEqual(["v1->v2", "v2->v3"]);
        expect(mock.activeReplicaName()).toBe("x");
        const activeStorage = mock.activeReplicaName() === "x" ? xStorage : yStorage;
        expect(await activeStorage.global.get("version")).toBe("v3");
    });

    test("applies each edge's own codec so a representation change composes across the chain", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const nodeKey = fixtureNode("A");
        await seedNode(xStorage, nodeKey);
        await seedGraphScheme(xStorage, CHAIN_CODEC_SOURCE_NODE_DEFS);
        await xStorage.global.put("version", "v1");

        const mock = makeVersionAwareRootDatabaseMock({
            currentVersion: "v3",
            xStorage,
            yStorage,
        });

        const codec1 = makeJournalFormatCodec({
            rewriteNodeKey: (sourceKey) => ({ head: `${sourceKey.head}2`, args: sourceKey.args }),
        });
        const codec2 = makeJournalFormatCodec({
            rewriteNodeKey: (sourceKey) => ({ head: `${sourceKey.head}3`, args: sourceKey.args }),
        });
        if (codec1 instanceof Error) {
            throw codec1;
        }
        if (codec2 instanceof Error) {
            throw codec2;
        }

        const chain = makeCanonicalMigrationChain([
            { sourceVersion: "v1", targetVersion: "v2", codec: codec1, callback: async (storage) => {
                for await (const identifier of storage.listMaterializedNodes()) {
                    await storage.keep(identifier);
                }
            } },
            { sourceVersion: "v2", targetVersion: "v3", codec: codec2, callback: async (storage) => {
                for await (const identifier of storage.listMaterializedNodes()) {
                    await storage.keep(identifier);
                }
            } },
        ]);
        if (isJournalVersionCompatibilityError(chain)) {
            throw chain;
        }

        await runMigration(capabilities, mock.rootDatabase, CHAIN_CODEC_NODE_DEFS, async () => {}, undefined, chain);

        const activeStorage = mock.activeReplicaName() === "x" ? xStorage : yStorage;
        const identifiers = await activeStorage.global.get(IDENTIFIERS_KEY);
        expect(Array.isArray(identifiers)).toBe(true);
        if (!Array.isArray(identifiers)) {
            return;
        }
        const keys = identifiers.map(([, key]) => String(key));
        expect(keys).toContain(toJsonKey("A23"));
    });

    test("a stored version with no complete canonical chain fails compatibility before any cutover", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const nodeKey = fixtureNode("A");
        await seedNode(xStorage, nodeKey);
        await seedGraphScheme(xStorage, NODE_DEFS);
        await xStorage.global.put("version", "v1");

        const mock = makeVersionAwareRootDatabaseMock({
            currentVersion: "v3",
            xStorage,
            yStorage,
        });

        const chain = makeCanonicalMigrationChain([
            { sourceVersion: "v1", targetVersion: "v2", codec: makeIdentityJournalFormatCodec(), callback: async () => {} },
        ]);
        if (isJournalVersionCompatibilityError(chain)) {
            throw chain;
        }

        let caught;
        try {
            await runMigration(capabilities, mock.rootDatabase, NODE_DEFS, async () => {}, undefined, chain);
        } catch (error) {
            caught = error;
        }
        expect(isJournalVersionCompatibilityError(caught)).toBe(true);
        expect(mock.activeReplicaName()).toBe("x");
        expect(await yStorage.global.get("version")).toBeUndefined();
    });
});
