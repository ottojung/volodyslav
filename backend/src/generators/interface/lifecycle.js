/**
 * Lifecycle operations for the generators interface.
 */

/** @typedef {import('../incremental_graph/database/root_database').RootDatabase} RootDatabase */
/** @typedef {import('../incremental_graph/types').NodeDef} NodeDef */
/** @typedef {import('../incremental_graph/migration_storage').MigrationStorage} MigrationStorage */
/** @typedef {import('./types').GeneratorsCapabilities} GeneratorsCapabilities */
/**
 * @typedef {object} InterfaceLifecycleAccess
 * @property {() => GeneratorsCapabilities} _getCapabilities
 * @property {import('../incremental_graph').IncrementalGraph | null} _incrementalGraph
 * @property {RootDatabase | null} _database
 * @property {import('../individual/all_events/wrapper').AllEventsBox | null} _allEventsBox
 * @property {import('../individual/config/wrapper').ConfigBox | null} _configBox
 * @property {import('../individual/diary_most_important_info_summary/wrapper').DiarySummaryBox | null} _diarySummaryBox
 * @property {import('../individual/ontology/wrapper').OntologyBox | null} _ontologyBox
 */

const path = require('path');
const {
    makeIncrementalGraph,
    getRootDatabase,
    runMigrationUnsafe,
    synchronizeNoLock,
    withExclusiveMode,
    migrationCallback,
    LIVE_DATABASE_WORKING_PATH,
} = require("../incremental_graph");
const defaultBranch = require("../../gitstore/default_branch");
const { createDefaultGraphDefinition } = require("./default_graph");
const { makeSynchronizeDatabaseError } = require("./errors");
const { allEvents, config, diarySummary, ontology } = require("../individual");

/** @param {InterfaceLifecycleAccess} interfaceInstance */
function internalIsInitialized(interfaceInstance) {
    return interfaceInstance._incrementalGraph !== null;
}

/**
 * @param {InterfaceLifecycleAccess} interfaceInstance
 * @returns {import('../incremental_graph').IncrementalGraph}
 */
function internalRequireInitializedGraph(interfaceInstance) {
    if (interfaceInstance._incrementalGraph === null) {
        throw new Error("Impossible: expected non-null");
    }
    return interfaceInstance._incrementalGraph;
}

/** @param {InterfaceLifecycleAccess} interfaceInstance */
async function internalEnsureInitialized(interfaceInstance) {
    if (interfaceInstance._incrementalGraph !== null) {
        return;
    }
    const capabilities = interfaceInstance._getCapabilities();
    await withExclusiveMode(capabilities.sleeper, async () => {
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

        await internalEnsureInitializedWithMigration(interfaceInstance, runMigrationUnsafe);

        capabilities.logger.logInfo(
            {},
            'Bootstrap: startup completed successfully'
        );
    });
}

/**
 * Select and execute the bootstrap path when the live LevelDB is absent.
 *
 * Protocol section 7.1:
 *  1. Check if `<hostname>-main` exists on the remote.
 *  2. If yes  → reset-to-hostname sync (restores snapshot; fatal on any error).
 *  3. If no   → normal sync from empty local DB (fatal on any error).
 *
 * @param {GeneratorsCapabilities} capabilities
 * @returns {Promise<void>}
 */
async function internalBootstrap(capabilities) {
    const hostname = capabilities.environment.hostname();
    const remotePath = capabilities.environment.generatorsRepository();
    const hostnameBranch = defaultBranch(capabilities);
    const hostnameBranchRef = `refs/heads/${hostnameBranch}`;

    capabilities.logger.logInfo(
        { hostname, remotePath, hostnameBranch },
        'Bootstrap: checking if hostname branch exists on remote'
    );

    // Query the remote without requiring a local clone.  Any error here
    // (e.g. remote unreachable) propagates as a fatal startup crash.
    const lsRemoteResult = await capabilities.git.call(
        "ls-remote", "--heads", "--", remotePath, hostnameBranchRef
    );
    const hostnameBranchExists = lsRemoteResult.stdout.trim() !== '';

    if (hostnameBranchExists) {
        capabilities.logger.logInfo(
            { hostname, hostnameBranch },
            'Bootstrap: hostname branch found; using reset-to-hostname sync path'
        );
        // Phase 1 (protocol §7.1.2): restore from remote snapshot.
        // Any error is fatal (protocol §8.3).
        await synchronizeNoLock(capabilities, { resetToHostname: hostname });
        capabilities.logger.logInfo(
            { hostname },
            'Bootstrap: reset-to-hostname sync completed'
        );
    } else {
        capabilities.logger.logInfo(
            { hostname, hostnameBranch },
            'Bootstrap: hostname branch does not exist remotely; using normal sync fallback'
        );
        // Phase 1 fallback (protocol §7.1.3): normal sync from empty local DB.
        // Any error is fatal (protocol §8.3).
        await synchronizeNoLock(capabilities);
        capabilities.logger.logInfo(
            { hostname },
            'Bootstrap: fallback normal sync completed'
        );
    }
}

/**
 * @param {InterfaceLifecycleAccess} interfaceInstance
 * @param {(capabilities: GeneratorsCapabilities, database: RootDatabase, nodeDefs: Array<NodeDef>, callback: (storage: MigrationStorage) => Promise<void>) => Promise<void>} runMigrationProcedure
 * @returns {Promise<void>}
 */
async function internalEnsureInitializedWithMigration(
    interfaceInstance,
    runMigrationProcedure
) {
    if (interfaceInstance._incrementalGraph !== null) {
        return;
    }

    const capabilities = interfaceInstance._getCapabilities();
    const database = await getRootDatabase(capabilities);
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
        await runMigrationProcedure(
            capabilities,
            database,
            nodeDefs,
            migrationCallback(capabilities),
        );
        const incrementalGraph = makeIncrementalGraph(
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
 * @param {InterfaceLifecycleAccess} interfaceInstance
 * @param {{ resetToHostname?: string }} [options]
 */
async function internalSynchronizeDatabase(interfaceInstance, options) {
    await withExclusiveMode(interfaceInstance._getCapabilities().sleeper, async () => {
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
    const database = interfaceInstance._database;
    const incrementalGraph = interfaceInstance._incrementalGraph;
    const allEventsBox = interfaceInstance._allEventsBox;
    const configBox = interfaceInstance._configBox;
    const diarySummaryBox = interfaceInstance._diarySummaryBox;
    const ontologyBox = interfaceInstance._ontologyBox;
    if (database === null) {
        await synchronizeNoLock(capabilities, options);
        return;
    }

    interfaceInstance._database = null;
    interfaceInstance._incrementalGraph = null;
    interfaceInstance._allEventsBox = null;
    interfaceInstance._configBox = null;
    interfaceInstance._diarySummaryBox = null;
    interfaceInstance._ontologyBox = null;

    try {
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
        await synchronizeNoLock(capabilities, options);
    } catch (error) {
        synchronizeFailure = error;
    }

    let reopenFailure = null;
    try {
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
