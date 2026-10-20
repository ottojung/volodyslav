/**
 * Lifecycle operations for the generators interface.
 */

/** @typedef {import('../incremental_graph').IncrementalGraph} IncrementalGraph
/** @typedef {import('../incremental_graph/database/root_database').RootDatabase} RootDatabase */
/** @typedef {import('../incremental_graph/types').NodeDef} NodeDef */
/** @typedef {import('../incremental_graph/migration_storage').MigrationStorage} MigrationStorage */
/** @typedef {import('./types').GeneratorsCapabilities} GeneratorsCapabilities */
/**
 * @typedef {object} InterfaceLifecycleAccess
 * @property {() => GeneratorsCapabilities} _getCapabilities
 * @property {IncrementalGraph | null} _incrementalGraph
 * @property {RootDatabase | null} _database
 * @property {import('../individual/all_events/wrapper').AllEventsBox | null} _allEventsBox
 * @property {import('../individual/config/wrapper').ConfigBox | null} _configBox
 * @property {import('../individual/diary_most_important_info_summary/wrapper').DiarySummaryBox | null} _diarySummaryBox
 * @property {import('../individual/ontology/wrapper').OntologyBox | null} _ontologyBox
 */

const path = require('path');
const {
    getRootDatabase,
    runMigrationUnsafe,
    synchronizeNoLock,
    holidayActivity,
    migrationCallback,
    createIncrementalGraph,
    makeCanonicalMigrationChain,
    makeIdentityJournalFormatCodec,
    isJournalVersionCompatibilityError,
    LIVE_DATABASE_WORKING_PATH,
    syncJournalReceiverToSource,
    resetJournalReceiverToSnapshot,
    runCanonicalBootstrapGate,
    gitInstallationRecoverySource,
    gitCanonicalBootstrapSource,
    queryInstallationRecovery,
    restoreAbsentFrom,
    isRecoveryDefinitelyAbsent,
    isRecoveryExists,
    isRecoveryIndeterminate,
    makeJournalPublicationError,
} = require("../incremental_graph");
const { createDefaultGraphDefinition } = require("./default_graph");
const { makeSynchronizeDatabaseError, makeUnresolvedCanonicalBootstrapError } = require("./errors");
const { allEvents, config, diarySummary, ontology } = require("../individual");

/**
 * The Journal front an operation is performed with.
 *
 * A synchronization of a receiver which retains Journal records is performed by the
 * Journal synchronization rather than by a fieldwise merge, and a reset of such a
 * receiver is performed by the Journal reset rather than by adopting the snapshot's
 * rows. The operation is given the front its mode names, so a reset which reaches a
 * Journal receiver resets it through the Journal instead of stopping at the missing
 * front.
 *
 * @param {{ resetToHostname?: string } | undefined} options
 * @returns {{ resetToHostname?: string, journalReset?: import('../incremental_graph/journal_publish').ResetReceiverToSnapshot, journalSync?: import('../incremental_graph/journal_publish').SyncReceiverToSource } | undefined}
 */
function withJournalSync(options) {
    if (options?.resetToHostname !== undefined) {
        return { ...options, journalReset: resetJournalReceiverToSnapshot };
    }
    return { ...options, journalSync: syncJournalReceiverToSource };
}

/** @param {InterfaceLifecycleAccess} interfaceInstance */
function internalIsInitialized(interfaceInstance) {
    return interfaceInstance._incrementalGraph !== null;
}

/**
 * @param {InterfaceLifecycleAccess} interfaceInstance
 * @returns {IncrementalGraph}
 */
function internalRequireInitializedGraph(interfaceInstance) {
    if (interfaceInstance._incrementalGraph === null) {
        throw new Error("Impossible: expected non-null");
    }
    return interfaceInstance._incrementalGraph;
}

/**
 * @param {InterfaceLifecycleAccess} interfaceInstance
 * @returns {Promise<IncrementalGraph>}
 */
async function internalEnsureInitialized(interfaceInstance) {
    if (interfaceInstance._incrementalGraph !== null) {
        return interfaceInstance._incrementalGraph;
    }
    const capabilities = interfaceInstance._getCapabilities();
    return await holidayActivity(capabilities.sleeper, async () => {
        const liveDbPath = path.join(
            capabilities.environment.workingDirectory(),
            LIVE_DATABASE_WORKING_PATH
        );
        const liveDbExists = (await capabilities.checker.directoryExists(liveDbPath)) !== null;

        capabilities.logger.logInfo(
            { liveDbPath, liveDbExists },
            liveDbExists
                ? 'Bootstrap: live database directory present; proceeding to open'
                : 'Bootstrap: live database directory absent; selecting bootstrap path'
        );

        if (!liveDbExists) {
            await internalBootstrap(capabilities);
        }

        const ret = await internalEnsureInitializedWithMigration(interfaceInstance, runMigrationUnsafe);

        capabilities.logger.logInfo(
            {},
            'Bootstrap: startup completed successfully'
        );

        return ret;
    });
}

/**
 * Select and execute the bootstrap path when the live LevelDB is absent.
 *
 * `database-lifecycle.md` §4 / `database-boot-sequence.md` §7.1: the absent-state
 * decision queries the transport-neutral `InstallationRecoverySource` and follows
 * exactly one of its answers:
 *  - `Exists(ContinuationSafeSnapshot)` → receiver-less restore of the held snapshot;
 *  - `DefinitelyAbsent` → fresh creation of the empty local database;
 *  - `IndeterminateOrError` → fatal, with no fallback to fresh creation.
 *
 * Recovery derives its source from the existing Git-backed transport, without
 * adding root capabilities or persisting any transport locator.
 *
 * @param {GeneratorsCapabilities} capabilities
 * @returns {Promise<void>}
 */
async function internalBootstrap(capabilities) {
    const source = gitInstallationRecoverySource(capabilities);
    if (source instanceof Error) {
        throw source;
    }

    const answer = await queryInstallationRecovery(source);

    if (isRecoveryExists(answer)) {
        capabilities.logger.logInfo(
            {},
            'Bootstrap: installation recovery source holds a continuation-safe snapshot; restoring'
        );
        await restoreAbsentFrom(capabilities, answer.snapshot);
        capabilities.logger.logInfo(
            {},
            'Bootstrap: absent-state restore completed'
        );
        return;
    }

    if (isRecoveryDefinitelyAbsent(answer)) {
        capabilities.logger.logInfo(
            {},
            'Bootstrap: installation recovery source reports definite absence; creating fresh'
        );
        // Fresh creation is local and direct. Opening the absent database creates
        // the empty live replica, and the startup gate that follows initializes its
        // fingerprint, version/schema metadata and empty graph. `database-lifecycle.md`
        // §4.3 and `database-boot-sequence.md` §7.1 forbid falling back to normal
        // synchronization from an empty local database, so no host-branch merge runs
        // here and this fresh replica retains no foreign history. The first ordinary
        // synchronization publishes this installation's branch.
        return;
    }

    if (isRecoveryIndeterminate(answer)) {
        throw makeJournalPublicationError(
            'the installation recovery query was indeterminate, so startup fails without fresh creation: ' +
                answer.detail
        );
    }

    throw makeJournalPublicationError(
        'the installation recovery query returned an unrecognized answer'
    );
}

/**
 * @param {InterfaceLifecycleAccess} interfaceInstance
 * @param {(capabilities: GeneratorsCapabilities, database: RootDatabase, nodeDefs: Array<NodeDef>, callback: (storage: MigrationStorage) => Promise<void>, codec?: import('../incremental_graph/migration_codec').JournalFormatCodec, chain?: import('../incremental_graph/journal_migration_chain').CanonicalMigrationChain) => Promise<RootDatabase>} runMigrationProcedure
 * @returns {Promise<IncrementalGraph>}
 */
async function internalEnsureInitializedWithMigration(
    interfaceInstance,
    runMigrationProcedure
) {
    if (interfaceInstance._incrementalGraph !== null) {
        return interfaceInstance._incrementalGraph;
    }

    const capabilities = interfaceInstance._getCapabilities();
    capabilities.logger.logDebug({}, 'Initialization: opening root database for graph lifecycle');
    let database = await getRootDatabase(capabilities);
    const configBox = config.makeBox();
    const allEventsBox = allEvents.makeBox();
    const diarySummaryBox = diarySummary.makeBox();
    const ontologyBox = ontology.makeBox();
    const nodeDefs = createDefaultGraphDefinition(
        capabilities,
        configBox,
        allEventsBox,
        diarySummaryBox,
        ontologyBox
    );
    try {
        capabilities.logger.logDebug({}, 'Initialization: running migration gate before graph construction');
        // `incremental-graph-journal-migrations.md` §9b: startup resolves the release's
        // canonical migration chain from the stored version to the running version and
        // hands it to the migration procedure. The release lineage today carries exactly
        // one Journal version, so the canonical chain from a stored version to the running
        // version is legitimately the single direct identity edge; building it here —
        // rather than letting the migration runner synthesize it — keeps startup routed
        // through the canonical chain registry, so a future second version must declare
        // its real lineage at this call site instead of silently running the identity
        // edge. The runner's equal-version and no-stored-version early returns run
        // before chain resolution, so the empty chain supplied for those states is
        // never resolved.
        const storedVersion = await database.getGlobalVersion();
        const currentVersion = database.getVersion();
        const canonicalChain = makeCanonicalMigrationChain(
            storedVersion === undefined || storedVersion === currentVersion
                ? []
                : [{
                    sourceVersion: storedVersion,
                    targetVersion: currentVersion,
                    codec: makeIdentityJournalFormatCodec(),
                    callback: migrationCallback(capabilities),
                }]
        );
        if (isJournalVersionCompatibilityError(canonicalChain)) {
            throw canonicalChain;
        }
        database = await runMigrationProcedure(
            capabilities,
            database,
            nodeDefs,
            migrationCallback(capabilities),
            undefined,
            canonicalChain,
        );
        capabilities.logger.logDebug({}, 'Initialization: migration gate completed, running canonical bootstrap gate');
        await internalCanonicalBootstrapGate(capabilities, database, nodeDefs);
        capabilities.logger.logDebug({}, 'Initialization: canonical bootstrap gate completed, constructing incremental graph');
        const incrementalGraph = await createIncrementalGraph(
            capabilities,
            database,
            nodeDefs
        );
        interfaceInstance._database = database;
        interfaceInstance._incrementalGraph = incrementalGraph;
        interfaceInstance._allEventsBox = allEventsBox;
        interfaceInstance._configBox = configBox;
        interfaceInstance._diarySummaryBox = diarySummaryBox;
        interfaceInstance._ontologyBox = ontologyBox;
        return incrementalGraph;
    } catch (error) {
        try {
            await database.close();
        } catch (closeError) {
            // Swallow close errors to avoid masking the original failure.
            capabilities.logger.logDebug(
                { closeError },
                `Failed to close database after initialization failure: ${closeError}`,
            );
        }
        throw error;
    }
}

/**
 * Run the Journal 3 canonical-bootstrap gate before any graph API is exposed.
 *
 * `database-lifecycle.md` §8.2 requires startup to resolve a canonical
 * bootstrap for a supported pre-Journal replica before graph construction, and requires
 * an unresolved publication outcome to fail startup while leaving the pre-Journal
 * database selected. The gate reports that outcome rather than retrying it, because §6
 * requires a re-query through the owned procedure before another publication attempt.
 *
 * The source is derived from the existing Git-backed transport and its atomic
 * expected-absent publication ref; it is never added to root capabilities or
 * persisted as a hostname/locator in the database.
 *
 * @param {GeneratorsCapabilities} capabilities
 * @param {RootDatabase} database
 * @param {NodeDef[]} nodeDefs
 * @returns {Promise<void>}
 */
async function internalCanonicalBootstrapGate(capabilities, database, nodeDefs) {
    const source = gitCanonicalBootstrapSource(capabilities);
    if (source instanceof Error) {
        throw source;
    }
    const outcome = await runCanonicalBootstrapGate({
        rootDatabase: database,
        nodeDefs,
        source,
        logger: capabilities.logger,
    });
    if (outcome.status === 'unresolved-canonical-bootstrap') {
        throw makeUnresolvedCanonicalBootstrapError(outcome.detail);
    }
}

/**
 * @param {InterfaceLifecycleAccess} interfaceInstance
 * @param {{ resetToHostname?: string }} [options]
 */
async function internalSynchronizeDatabase(interfaceInstance, options) {
    await holidayActivity(interfaceInstance._getCapabilities().sleeper, async () => {
        await internalSynchronizeDatabaseNoLock(interfaceInstance, options);
    });
}

/**
 * @param {InterfaceLifecycleAccess} interfaceInstance
 * @param {{ resetToHostname?: string }} [options]
 * @returns {Promise<void>}
 */
async function internalSynchronizeDatabaseNoLock(interfaceInstance, options) {
    const capabilities = interfaceInstance._getCapabilities();
    capabilities.logger.logDebug({ options }, 'Synchronize: entering no-lock synchronization path');
    const database = interfaceInstance._database;
    const incrementalGraph = interfaceInstance._incrementalGraph;
    const allEventsBox = interfaceInstance._allEventsBox;
    const configBox = interfaceInstance._configBox;
    const diarySummaryBox = interfaceInstance._diarySummaryBox;
    const ontologyBox = interfaceInstance._ontologyBox;
    if (database === null) {
        capabilities.logger.logDebug({ options }, 'Synchronize: interface database is not open; synchronizing directly');
        await synchronizeNoLock(capabilities, withJournalSync(options));
        return;
    }

    interfaceInstance._database = null;
    interfaceInstance._incrementalGraph = null;
    interfaceInstance._allEventsBox = null;
    interfaceInstance._configBox = null;
    interfaceInstance._diarySummaryBox = null;
    interfaceInstance._ontologyBox = null;

    try {
        capabilities.logger.logDebug({ options }, 'Synchronize: closing currently opened database before sync/reset');
        await database.close();
    } catch (error) {
        interfaceInstance._database = database;
        interfaceInstance._incrementalGraph = incrementalGraph;
        interfaceInstance._allEventsBox = allEventsBox;
        interfaceInstance._configBox = configBox;
        interfaceInstance._diarySummaryBox = diarySummaryBox;
        interfaceInstance._ontologyBox = ontologyBox;
        throw error;
    }

    let synchronizeFailure = null;

    try {
        capabilities.logger.logDebug({ options }, 'Synchronize: running synchronizeNoLock');
        await synchronizeNoLock(capabilities, withJournalSync(options));
    } catch (error) {
        synchronizeFailure = error;
    }

    let reopenFailure = null;
    try {
        capabilities.logger.logDebug({ options }, 'Synchronize: reopening interface and re-running migration gate after sync/reset');
        await internalEnsureInitializedWithMigration(
            interfaceInstance,
            runMigrationUnsafe
        );
    } catch (error) {
        reopenFailure = error;
    }

    if (reopenFailure !== null) {
        if (synchronizeFailure !== null) {
            throw makeSynchronizeDatabaseError(
                synchronizeFailure,
                reopenFailure
            );
        }
        throw reopenFailure;
    }
    if (synchronizeFailure !== null) {
        throw synchronizeFailure;
    }
}

module.exports = {
    internalEnsureInitialized,
    internalEnsureInitializedWithMigration,
    internalIsInitialized,
    internalRequireInitializedGraph,
    internalSynchronizeDatabase,
    internalSynchronizeDatabaseNoLock,
};
