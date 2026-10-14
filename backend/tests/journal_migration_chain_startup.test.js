/**
 * The production startup migration call site supplies the canonical Journal
 * migration chain of `incremental-graph-journal-migrations.md` §9b.
 *
 * §9b gives every supported upgrade from one Journal version to another exactly
 * one canonical transition sequence, and `journal_migration_chain.js` is the
 * registry which carries it. Production startup —
 * `internalEnsureInitializedWithMigration` in `generators/interface/lifecycle.js`
 * — is the one caller that opens a real database, so it is the caller which
 * must resolve the release's canonical chain and hand it to the migration
 * procedure. A startup which lets the migration runner synthesize a direct
 * identity edge instead routes around the chain registry: the non-identity
 * `rewriteNodeKey`/`rewriteComputedValue` a later release declares for its
 * canonical edges would never run.
 *
 * The release lineage today carries exactly one Journal version, so the
 * canonical chain from a stored version to the running version is legitimately
 * the single direct identity edge. The property under test is that startup
 * builds that edge through `makeCanonicalMigrationChain` and supplies the
 * resulting chain, rather than supplying no chain at all.
 */

const { internalEnsureInitializedWithMigration } = require("../src/generators/interface/lifecycle");
const {
    makeCanonicalMigrationChain,
    canonicalNextJournalVersion,
} = require("../src/generators/incremental_graph/journal_migration_chain");
const { isJournalVersionCompatibilityError } = require("../src/generators/incremental_graph/journal");
const {
    isJournalFormatCodec,
    makeIdentityJournalFormatCodec,
} = require("../src/generators/incremental_graph/migration_codec");

jest.mock("../src/generators/incremental_graph", () => ({
    getRootDatabase: jest.fn(),
    runMigrationUnsafe: jest.fn(),
    synchronizeNoLock: jest.fn(),
    holidayActivity: jest.fn((_sleeper, work) => work()),
    migrationCallback: jest.fn(() => async () => {}),
    createIncrementalGraph: jest.fn(),
    makeCanonicalMigrationChain: jest.requireActual("../src/generators/incremental_graph/journal_migration_chain").makeCanonicalMigrationChain,
    makeIdentityJournalFormatCodec: jest.requireActual("../src/generators/incremental_graph/migration_codec").makeIdentityJournalFormatCodec,
    isJournalVersionCompatibilityError: jest.requireActual("../src/generators/incremental_graph/journal").isJournalVersionCompatibilityError,
    LIVE_DATABASE_WORKING_PATH: "live-database",
    CHECKPOINT_WORKING_PATH: "checkpoint",
    syncJournalReceiverToSource: jest.fn(),
    runCanonicalBootstrapGate: jest.fn(),
    queryInstallationRecovery: jest.fn(),
    restoreAbsentFrom: jest.fn(),
    isRecoveryDefinitelyAbsent: jest.fn(),
    isRecoveryExists: jest.fn(),
    isRecoveryIndeterminate: jest.fn(),
    makeJournalPublicationError: jest.fn(),
}));

jest.mock("../src/generators/individual", () => ({
    allEvents: { makeBox: jest.fn(() => ({})) },
    config: { makeBox: jest.fn(() => ({})) },
    diarySummary: { makeBox: jest.fn(() => ({})) },
    ontology: { makeBox: jest.fn(() => ({})) },
}));

jest.mock("../src/generators/interface/default_graph", () => ({
    createDefaultGraphDefinition: jest.fn(() => []),
}));

const STORED_VERSION = "0.1.0-stored";
const CURRENT_VERSION = "0.1.0";

/**
 * @param {string} storedVersion
 * @returns {Promise<object>}
 */
function makeFakeDatabase(storedVersion) {
    return {
        getGlobalVersion: async () => storedVersion,
        getVersion: () => CURRENT_VERSION,
        close: async () => {},
    };
}

/**
 * @param {object} capabilities
 * @returns {object}
 */
function makeInterfaceInstance(capabilities) {
    return {
        _incrementalGraph: null,
        _database: null,
        _getCapabilities: () => capabilities,
    };
}

/**
 * Drives the production startup migration call site over a database storing
 * `storedVersion` and captures the arguments the migration procedure receives.
 *
 * @param {string} storedVersion
 * @returns {Promise<{capabilities: object, database: object, calls: Array<object>}>}
 */
async function driveStartup(storedVersion) {
    const incrementalGraph = require("../src/generators/incremental_graph");
    const { runCanonicalBootstrapGate, createIncrementalGraph } = incrementalGraph;
    const database = await makeFakeDatabase(storedVersion);
    incrementalGraph.getRootDatabase.mockResolvedValue(database);
    runCanonicalBootstrapGate.mockResolvedValue({ status: "no-pre-journal-state" });
    createIncrementalGraph.mockResolvedValue({ graph: true });
    const capabilities = {
        logger: { logDebug: jest.fn(), logInfo: jest.fn() },
    };
    /** @type {Array<object>} */
    const calls = [];
    const procedure = jest.fn(async (caps, db, nodeDefs, callback, codec, chain) => {
        calls.push({ caps, db, nodeDefs, callback, codec, chain });
        return db;
    });
    const instance = makeInterfaceInstance(capabilities);
    const result = await internalEnsureInitializedWithMigration(instance, procedure);
    expect(result).toEqual({ graph: true });
    expect(procedure).toHaveBeenCalledTimes(1);
    return { capabilities, database, calls };
}

describe("startup supplies the canonical migration chain", () => {
    test("a stored version different from the running version is supplied the direct identity edge of the release lineage, built through makeCanonicalMigrationChain", async () => {
        const { database, calls } = await driveStartup(STORED_VERSION);
        const arg = calls[0];
        expect(arg.db).toBe(database);
        // The transition codec stays unspecified; the chain's edge carries the
        // identity codec, which is what the migration actually runs with.
        expect(arg.codec).toBeUndefined();
        expect(arg.chain).toBeInstanceOf(Map);
        expect(isJournalVersionCompatibilityError(arg.chain)).toBe(false);
        expect(canonicalNextJournalVersion(arg.chain, STORED_VERSION)).toBe(CURRENT_VERSION);
        const edge = arg.chain.get(STORED_VERSION);
        expect(edge).toBeDefined();
        expect(edge.sourceVersion).toBe(STORED_VERSION);
        expect(edge.targetVersion).toBe(CURRENT_VERSION);
        expect(isJournalFormatCodec(edge.codec)).toBe(true);
        expect(edge.callback).toBeInstanceOf(Function);
        // The edge codec is the identity codec: neither representation changes.
        const identity = makeIdentityJournalFormatCodec();
        expect(edge.codec.rewriteNodeKey({ head: "all_events", args: [] }))
            .toEqual(identity.rewriteNodeKey({ head: "all_events", args: [] }));
        expect(edge.codec.rewriteComputedValue({ head: "all_events", args: [] }, { type: "all_events", events: [] }))
            .toEqual(identity.rewriteComputedValue({ head: "all_events", args: [] }, { type: "all_events", events: [] }));
    });

    test("a stored version equal to the running version is supplied the empty canonical chain of the single-version release", async () => {
        const { calls } = await driveStartup(CURRENT_VERSION);
        const arg = calls[0];
        expect(arg.chain).toBeInstanceOf(Map);
        expect(arg.chain.size).toBe(0);
        expect(canonicalNextJournalVersion(arg.chain, CURRENT_VERSION)).toBeUndefined();
    });

    test("a fresh database without a stored version is supplied the empty canonical chain", async () => {
        const { calls } = await driveStartup(undefined);
        const arg = calls[0];
        expect(arg.chain).toBeInstanceOf(Map);
        expect(arg.chain.size).toBe(0);
    });

    test("the supplied chain is exactly the release lineage's canonical chain for the stored version", async () => {
        const { calls } = await driveStartup(STORED_VERSION);
        const arg = calls[0];
        const expected = makeCanonicalMigrationChain([{
            sourceVersion: STORED_VERSION,
            targetVersion: CURRENT_VERSION,
            codec: makeIdentityJournalFormatCodec(),
            callback: async () => {},
        }]);
        expect(isJournalVersionCompatibilityError(expected)).toBe(false);
        if (isJournalVersionCompatibilityError(expected)) {
            return;
        }
        expect(arg.chain.get(STORED_VERSION).sourceVersion).toBe(expected.get(STORED_VERSION).sourceVersion);
        expect(arg.chain.get(STORED_VERSION).targetVersion).toBe(expected.get(STORED_VERSION).targetVersion);
    });
});
