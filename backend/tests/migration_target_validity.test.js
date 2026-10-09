/**
 * The target validity and target freshness a migration's decisions construct.
 *
 * `docs/specs/incremental-graph-journal-migrations.md` §11a.4 derives each
 * decision family's `TargetValid` and target freshness, and §11 makes the
 * `replace` decision the genuine semantic value replacement of an
 * already-materialized node. Two properties of that derivation are easy to get
 * wrong in opposite directions, so each one has a control which must fail if the
 * other one is wrong:
 *
 * - a `replace` establishes full positive proof against every selected direct
 *   target input occurrence, which a `keep` of a preexisting stale node does NOT
 *   do (a stale `keep` node is treated as a direct invalidation root);
 * - a `replace`d input authors a new occurrence, so a preserved dependent's
 *   carried proof edge which named the replaced occurrence is dropped, which a
 *   `keep`d input does NOT do.
 *
 * The occurrences are published without certificates, because a target validity
 * edge is M2's record to author; these fixtures exercise which edges the target
 * construction derives, not which ones replay currently supports.
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
    finalizeEmission,
    isValueEvent,
    makeJournalAuthor,
    nodeKeyToCanonicalString,
} = require("../src/generators/incremental_graph/journal");
const {
    appendJournalPublicationOps,
    makeInitialCommittedWriterState,
    readRetainedJournal,
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

/** The writer name every fixture replica publishes its own occurrences as. */
const FIXTURE_FINGERPRINT = "testtarvalfp";

/**
 * A replica addresses its graph sublevels by `NodeIdentifier`, so each fixture
 * head gets one identifier and the identifier lookup maps it back to the
 * semantic node key it denotes.
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
        noFlushDel(key) { store.delete(key); },
        putOp(key, value) { return { type: "put", sublevel: table, key, value }; },
        delOp(key) { return { type: "del", sublevel: table, key }; },
        async *keys() {
            for (const key of [...store.keys()].sort()) yield key;
        },
        apply(operation) {
            if (operation.sublevel !== table) {
                return;
            }
            if (operation.type === "put") {
                store.set(operation.key, operation.value);
            } else if (operation.type === "del") {
                store.delete(operation.key);
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
            for (const operation of operations) {
                values.apply(operation);
                freshness.apply(operation);
                global.apply(operation);
                valid.apply(operation);
                timestamps.apply(operation);
                journal.apply(operation);
            }
        },
    };
}

/** @returns {import('../src/generators/incremental_graph/journal/types').JournalAuthor} */
function fixtureLocalWriter() {
    const localWriter = makeJournalAuthor(FIXTURE_FINGERPRINT);
    if (localWriter instanceof Error) {
        throw new Error("the fixture fingerprint is not a valid writer name: " + localWriter.message);
    }
    return localWriter;
}

/**
 * Publish the ordinary occurrence a seeded node's graph state is a projection of.
 * @param {ReturnType<typeof makeSchemaStorage>} storage
 * @param {import('../src/generators/incremental_graph/database').NodeIdentifier} nodeIdentifier
 * @param {{createdAt: string, modifiedAt: string}} timestamps
 */
async function publishFixtureOccurrence(storage, nodeIdentifier, timestamps) {
    const initial = makeInitialCommittedWriterState(fixtureLocalWriter());
    if (initial instanceof Error) {
        throw new Error("the fixture writer state is malformed: " + initial.message);
    }
    const state = storage.fixtureWriterState === undefined ? initial : storage.fixtureWriterState;
    const publication = finalizeEmission({
        state,
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
    storage.fixtureWriterState = publication.writerState;
}

/**
 * Seed one node's graph state and the occurrence which explains it.
 * @param {ReturnType<typeof makeSchemaStorage>} storage
 * @param {import('../src/generators/incremental_graph/database').NodeIdentifier} nodeIdentifier
 * @param {{freshness?: import('../src/generators/incremental_graph/database').Freshness}} [options]
 */
async function seedNode(storage, nodeIdentifier, { freshness = "up-to-date" } = {}) {
    const timestamps = { createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-06-15T12:00:00.000Z" };
    await storage.values.put(nodeIdentifier, { type: "all_events", events: [] });
    await storage.freshness.put(nodeIdentifier, freshness);
    await storage.timestamps.put(nodeIdentifier, timestamps);
    await publishFixtureOccurrence(storage, nodeIdentifier, timestamps);
}

/**
 * Seed the two-node chain `makeNodeDefs` builds.
 * @param {ReturnType<typeof makeSchemaStorage>} storage
 * @param {{staleHead?: string, edge?: boolean}} [options] - Which head starts
 *   stale, and whether the source replica persisted the A→B validity edge.
 */
async function seedChain(storage, { staleHead, edge = true } = {}) {
    const nkA = fixtureNode("A");
    const nkB = fixtureNode("B");
    await seedNode(storage, nkA, staleHead === "A" ? { freshness: "potentially-outdated" } : {});
    await seedNode(storage, nkB, staleHead === "B" ? { freshness: "potentially-outdated" } : {});
    if (edge) {
        await storage.valid.put(nkA, [nkB]);
    }
    return { nkA, nkB };
}

/** The fan-in `makeFanInNodeDefs` builds, with both seeded validity edges. */
async function seedFanIn(storage) {
    const nkA = fixtureNode("A");
    const nkB = fixtureNode("B");
    const nkC = fixtureNode("C");
    await seedNode(storage, nkA);
    await seedNode(storage, nkB);
    await seedNode(storage, nkC);
    await storage.valid.put(nkA, [nkC]);
    await storage.valid.put(nkB, [nkC]);
    return { nkA, nkB, nkC };
}

function makeNodeDefs(names) {
    return names.map((name) => ({
        output: name,
        inputs: name === "B" ? ["A"]
            : name === "C" ? ["A", "B"]
                : [],
        computor: async () => ({ type: "all_events", events: [] }),
        isDeterministic: true,
        hasSideEffects: false,
    }));
}

/** NodeDefs for the fan-in schema A→C, B→C. */
function makeFanInNodeDefs() {
    return [
        { output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false },
        { output: "B", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false },
        { output: "C", inputs: ["A", "B"], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false },
    ];
}

/** Seed the graph scheme alone, without the identifier lookup or watermark. */
async function seedGraphSchemeOnly(storage, nodeDefs) {
    const compiledNodes = nodeDefs.map(compileNodeDef);
    const scheme = serializeGraphScheme(buildGraphSchemeFromNodeDefs(compiledNodes));
    await storage.global.put(GRAPH_SCHEME_KEY, JSON.stringify(scheme));
}

/**
 * Seed the graph scheme, the identifier lookup and the allocator watermark a
 * migrated source replica must have.
 * @param {ReturnType<typeof makeSchemaStorage>} storage
 * @param {Array<import('../src/generators/incremental_graph/types').NodeDef>} nodeDefs
 * @param {string[]} [materializedHeads] - Which heads the source materializes.
 *   Defaults to every head the nodeDefs name; a fixture which creates a genuinely
 *   new node seeds only the heads its source actually materialized, so the
 *   created node's target key is not already the source's.
 */
async function seedGraphScheme(storage, nodeDefs, materializedHeads = nodeDefs.map((def) => def.output)) {
    await seedGraphSchemeOnly(storage, nodeDefs);
    const identifiers = materializedHeads.map((head) => [fixtureNode(head), toJsonKey(head)]);
    await storage.global.put(IDENTIFIERS_KEY, identifiers);
    // The allocator watermark sits past every fixture identifier, so an
    // identifier a `create` allocates cannot collide with a source materialization.
    await storage.global.put(LAST_NODE_INDEX_KEY, fixtureIdentifiersByHead.size + 10);
}

/**
 * Build a standard in-memory rootDatabase mock over two replica namespaces.
 * @param {{prevVersion: string, currentVersion: string, xStorage: object, yStorage: object}} options
 */
function makeRootDatabaseMock({ prevVersion, currentVersion, xStorage, yStorage }) {
    const rootDatabase = {
        version: currentVersion,
        async getGlobalVersion() { return prevVersion; },
        getSchemaStorage() { return xStorage; },
        currentReplicaName() { return 'x'; },
        otherReplicaName() { return 'y'; },
        schemaStorageForReplica(name) {
            if (name === 'x') return xStorage;
            if (name === 'y') return yStorage;
            throw new Error(`Unexpected replica name: ${name}`);
        },
        async clearReplicaStorage(_name) {},
        async setCurrentReplicaPointer(_name) {},
        async setGlobalVersion(_version) {},
        async _rawSync() {},
        getFingerprint() { return FIXTURE_FINGERPRINT; },
        getVersion() { return this.version; },
        getLastNodeIndex() { return this._computed.lastNodeIndex; },
        advanceLastNodeIndex(value) { this._computed.lastNodeIndex = Math.max(this._computed.lastNodeIndex, value); },
        _computed: { lastNodeIndex: 0 },
    };
    return { rootDatabase };
}

/** @returns {Promise<object>} */
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

/**
 * Whether the target replica persisted the validity edge `input ⇝ dependent`.
 * @param {ReturnType<typeof makeSchemaStorage>} storage
 * @param {import('../src/generators/incremental_graph/database').NodeIdentifier} input
 * @param {import('../src/generators/incremental_graph/database').NodeIdentifier} dependent
 * @returns {Promise<boolean>}
 */
async function hasEdge(storage, input, dependent) {
    const valid = await storage.valid.get(input) ?? [];
    return valid.some((id) => nodeIdentifierToString(id) === nodeIdentifierToString(dependent));
}

// ─────────────────────────────────────────────────────────────────────────────
// A replacement establishes full positive target proof
// ─────────────────────────────────────────────────────────────────────────────

describe("a replacement establishes full positive target proof", () => {
    test("replace(B) proves A→B even though B was stale in the source", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const { nkA, nkB } = await seedChain(xStorage, { staleHead: "B", edge: false });
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yStorage });

        await seedGraphScheme(xStorage, makeNodeDefs(["A", "B"]));
        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A", "B"]), async (storage) => {
            await storage.keep(nkA);
            await storage.replace(nkB, async () => ({ type: "all_events", events: [] }));
        });

        await expect(hasEdge(yStorage, nkA, nkB)).resolves.toBe(true);
    });

    test("keep(B) of the same stale source proves no A→B edge", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const { nkA, nkB } = await seedChain(xStorage, { staleHead: "B", edge: false });
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yStorage });

        await seedGraphScheme(xStorage, makeNodeDefs(["A", "B"]));
        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A", "B"]), async (storage) => {
            await storage.keep(nkA);
            await storage.keep(nkB);
        });

        await expect(hasEdge(yStorage, nkA, nkB)).resolves.toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// A replacement's own target freshness
// ─────────────────────────────────────────────────────────────────────────────

describe("a replacement's target freshness follows its selected inputs", () => {
    test("replace(B) over a fresh A is up-to-date", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const { nkA, nkB } = await seedChain(xStorage);
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yStorage });

        await seedGraphScheme(xStorage, makeNodeDefs(["A", "B"]));
        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A", "B"]), async (storage) => {
            await storage.keep(nkA);
            await storage.replace(nkB, async () => ({ type: "all_events", events: [] }));
        });

        await expect(yStorage.freshness.get(nkB)).resolves.toBe("up-to-date");
        await expect(hasEdge(yStorage, nkA, nkB)).resolves.toBe(true);
    });

    test("replace(B) over a stale A keeps full own proof but is target-stale", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const { nkA, nkB } = await seedChain(xStorage, { staleHead: "A" });
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yStorage });

        await seedGraphScheme(xStorage, makeNodeDefs(["A", "B"]));
        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A", "B"]), async (storage) => {
            await storage.keep(nkA);
            await storage.replace(nkB, async () => ({ type: "all_events", events: [] }));
        });

        await expect(yStorage.freshness.get(nkA)).resolves.toBe("potentially-outdated");
        await expect(yStorage.freshness.get(nkB)).resolves.toBe("potentially-outdated");
        await expect(hasEdge(yStorage, nkA, nkB)).resolves.toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// A replaced input removes a preserved dependent's carried proof edge
// ─────────────────────────────────────────────────────────────────────────────

describe("a replaced input removes a preserved dependent's carried proof edge", () => {
    test("replace(A) drops A→B from the kept B's proof", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const { nkA, nkB } = await seedChain(xStorage);
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yStorage });

        await seedGraphScheme(xStorage, makeNodeDefs(["A", "B"]));
        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A", "B"]), async (storage) => {
            await storage.replace(nkA, async () => ({ type: "all_events", events: [] }));
            await storage.keep(nkB);
        });

        await expect(hasEdge(yStorage, nkA, nkB)).resolves.toBe(false);
    });

    test("keep(A) keeps A→B for the kept B, so the control fails if the edge were dropped for any input", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const { nkA, nkB } = await seedChain(xStorage);
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yStorage });

        await seedGraphScheme(xStorage, makeNodeDefs(["A", "B"]));
        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A", "B"]), async (storage) => {
            await storage.keep(nkA);
            await storage.keep(nkB);
        });

        await expect(hasEdge(yStorage, nkA, nkB)).resolves.toBe(true);
    });

    test("along a chain, the replacement proves its own input edge and drops the edge a preserved dependent carried", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const nkA = fixtureNode("A");
        const nkB = fixtureNode("B");
        const nkC = fixtureNode("C");
        await seedNode(xStorage, nkA);
        await seedNode(xStorage, nkB);
        await seedNode(xStorage, nkC);
        await xStorage.valid.put(nkA, [nkB]);
        await xStorage.valid.put(nkB, [nkC]);
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yStorage });

        const nodeDefs = [
            { output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false },
            { output: "B", inputs: ["A"], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false },
            { output: "C", inputs: ["B"], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false },
        ];
        await seedGraphScheme(xStorage, nodeDefs);
        await runMigration(capabilities, rootDatabase, nodeDefs, async (storage) => {
            await storage.keep(nkA);
            await storage.replace(nkB, async () => ({ type: "all_events", events: [] }));
            await storage.keep(nkC);
        });

        await expect(hasEdge(yStorage, nkA, nkB)).resolves.toBe(true);
        await expect(hasEdge(yStorage, nkB, nkC)).resolves.toBe(false);
    });

    test("an unaffected provenance-valid edge of a kept fan-in dependent survives its replaced sibling input", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const { nkA, nkB, nkC } = await seedFanIn(xStorage);
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yStorage });

        await seedGraphScheme(xStorage, makeFanInNodeDefs());
        await runMigration(capabilities, rootDatabase, makeFanInNodeDefs(), async (storage) => {
            await storage.replace(nkA, async () => ({ type: "all_events", events: [] }));
            await storage.keep(nkB);
            await storage.keep(nkC);
        });

        await expect(hasEdge(yStorage, nkA, nkC)).resolves.toBe(false);
        await expect(hasEdge(yStorage, nkB, nkC)).resolves.toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// §11a.2 structural delete closure
// ─────────────────────────────────────────────────────────────────────────────

describe("structural delete closure", () => {
    test("delete(A) with B undecided propagates an absence to B", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const { nkA, nkB } = await seedChain(xStorage);
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yStorage });

        await seedGraphScheme(xStorage, makeNodeDefs(["A", "B"]));
        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A", "B"]), async (storage) => {
            await storage.delete(nkA);
        });

        await expect(yStorage.values.get(nkA)).resolves.toBeUndefined();
        await expect(yStorage.values.get(nkB)).resolves.toBeUndefined();
        await expect(hasEdge(yStorage, nkA, nkB)).resolves.toBe(false);
    });

    test("delete(A); keep(B) fails DecisionConflictError rather than retaining B without its input", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const { nkA, nkB } = await seedChain(xStorage);
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yStorage });

        await seedGraphScheme(xStorage, makeNodeDefs(["A", "B"]));
        await expect(runMigration(capabilities, rootDatabase, makeNodeDefs(["A", "B"]), async (storage) => {
            await storage.delete(nkA);
            await storage.keep(nkB);
        })).rejects.toThrow(/Decision conflict for node/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// §11a.4 A potentially-outdated create on a zero-input node stays stale
// ─────────────────────────────────────────────────────────────────────────────

describe("a potentially-outdated create stays stale", () => {
    test("a zero-input create asserts no positive incoming validity and is persisted stale", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const nkA = fixtureNode("A");
        await seedNode(xStorage, nkA);
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yStorage });

        // Only A is materialized in the source. NEW is a new zero-input node the
        // target schema adds, so it has no target input edge to prove at all.
        const nodeDefs = [
            { output: "A", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false },
            { output: "NEW", inputs: [], computor: async () => ({ type: "all_events", events: [] }), isDeterministic: true, hasSideEffects: false },
        ];
        await seedGraphScheme(xStorage, nodeDefs, ["A"]);
        await runMigration(capabilities, rootDatabase, nodeDefs, async (storage) => {
            await storage.keep(nkA);
            await storage.create(toJsonKey("NEW"), async () => ({ type: "all_events", events: [] }), "potentially-outdated");
        });

        const lookup = await yStorage.global.get(IDENTIFIERS_KEY);
        const created = lookup.find(([, key]) => String(key) === toJsonKey("NEW"));
        expect(created).toBeDefined();
        if (created === undefined) {
            return;
        }
        const createdIdentifier = created[0];
        expect(nodeIdentifierToString(createdIdentifier)).not.toBe(nodeIdentifierToString(nkA));
        await expect(yStorage.freshness.get(nodeIdentifierToString(createdIdentifier)))
            .resolves.toBe("potentially-outdated");
        await expect(hasEdge(yStorage, nkA, createdIdentifier)).resolves.toBe(false);
    });
});


describe("a replacement preserves its materialization and mints a new occurrence", () => {
    test("the target keeps B's identifier and authors a second ValueEvent for B's node key", async () => {
        const capabilities = await getTestCapabilities();
        const xStorage = makeSchemaStorage();
        const yStorage = makeSchemaStorage();
        const { nkA, nkB } = await seedChain(xStorage);
        const { rootDatabase } = makeRootDatabaseMock({ prevVersion: "1", currentVersion: "2", xStorage, yStorage });

        await seedGraphScheme(xStorage, makeNodeDefs(["A", "B"]));
        await runMigration(capabilities, rootDatabase, makeNodeDefs(["A", "B"]), async (storage) => {
            await storage.keep(nkA);
            await storage.replace(nkB, async () => ({ type: "all_events", events: [] }));
        });

        const lookup = await yStorage.global.get(IDENTIFIERS_KEY);
        const entry = lookup.find(([identifier]) => nodeIdentifierToString(identifier) === nodeIdentifierToString(nkB));
        expect(entry).toBeDefined();
        expect(entry[1]).toBe(toJsonKey("B"));

        const retained = await readRetainedJournal(yStorage.journal);
        if (retained instanceof Error) {
            throw retained;
        }
        const valueEvents = [];
        for (const records of retained.values()) {
            for (const record of records) {
                if (isValueEvent(record) && nodeKeyToCanonicalString(record.node) === toJsonKey("B")) {
                    valueEvents.push(record);
                }
            }
        }
        expect(valueEvents.length).toBe(2);
        const identities = new Set(valueEvents.map((record) => nodeIdentifierToString(record.nodeIdentifier)));
        expect(identities).toEqual(new Set([nodeIdentifierToString(nkB)]));
    });
});
