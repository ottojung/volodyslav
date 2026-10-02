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
    LIVE_DATABASE_WORKING_PATH,
    CHECKPOINT_WORKING_PATH,
} = require("../incremental_graph");
const { defaultBranch, workingRepository } = require("../../gitstore");
const { createDefaultGraphDefinition } = require("./default_graph");
const { makeSynchronizeDatabaseError } = require("./errors");
const { allEvents, config, diarySummary, ontology } = require("../individual");

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
 * Thrown when the absent-installation decision cannot be made, so that neither
 * restoration nor fresh identity creation is permitted.
 */
class AbsentInstallationRecoveryError extends Error {
    /**
     * @param {string} reason
     */
    constructor(reason) {
        super(`Cannot decide absent-installation recovery: ${reason}`);
        this.name = 'AbsentInstallationRecoveryError';
        this.reason = reason;
    }
}

/**
 * @param {unknown} object
 * @returns {object is AbsentInstallationRecoveryError}
 */
function isAbsentInstallationRecoveryError(object) {
    return object instanceof AbsentInstallationRecoveryError;
}

/**
 * @typedef {{ kind: 'exists', publishedHead: string }} RecoverySourceExists
 * @property {'exists'} kind
 * @property {string} publishedHead - the published commit the source held.
 *
 * @typedef {{ kind: 'definitely-absent' }} RecoverySourceDefinitelyAbsent
 * @property {'definitely-absent'} kind
 *
 * @typedef {{ kind: 'indeterminate-or-error', reason: string }} RecoverySourceIndeterminate
 * @property {'indeterminate-or-error'} kind
 * @property {string} reason
 *
 * @typedef {RecoverySourceExists | RecoverySourceDefinitelyAbsent | RecoverySourceIndeterminate} RecoveryQueryAnswer
 */

/**
 * Build the installation recovery source for this deployment's transport.
 *
 * The properties that this value carries are:
 * - its `query` answers exactly the question the absent-installation decision
 *   asks, returning one `RecoveryQueryAnswer` variant and nothing else;
 * - it exposes no hostname, branch name, repository locator or path, so the
 *   transport locators stay outside the source's semantic interface.
 *
 * The proof of those properties is guaranteed by:
 * - `internalMakeInstallationRecoverySource(capabilities)`: satisfies the first
 *   property because its `query` returns the result of
 *   `internalQueryInstallationRecoverySource`, which returns one of the three
 *   `RecoveryQueryAnswer` variants on every path.
 * - The second property holds because the transport locators are read from
 *   `capabilities.environment` inside that closure and are never stored on the
 *   returned value.
 *
 * @param {GeneratorsCapabilities} capabilities
 * @returns {{ query: () => Promise<RecoveryQueryAnswer> }}
 */
function internalMakeInstallationRecoverySource(capabilities) {
    return {
        async query() {
            const remotePath = capabilities.environment.generatorsRepository();
            const recoveryRef = `refs/heads/${defaultBranch(capabilities)}`;
            capabilities.logger.logInfo(
                { remotePath, recoveryRef },
                'Bootstrap: querying the installation recovery source'
            );
            return await internalQueryInstallationRecoverySource(
                capabilities,
                remotePath,
                recoveryRef
            );
        },
    };
}

/**
 * Ask the recovery source whether this installation has recoverable
 * synchronized state.
 *
 * Only two answers permit startup to continue. A published head which the
 * source can hold is `exists`; a publication ref which is absent is
 * `definitely-absent`. Every other outcome — an unreadable remote, an
 * unparseable ref, a head which cannot be fetched, or a head which moved
 * between the listing and the fetch — is `indeterminate-or-error`, because a
 * source which cannot deliver what it reported must not be treated as absence.
 *
 * @param {GeneratorsCapabilities} capabilities
 * @param {string} remotePath
 * @param {string} recoveryRef
 * @returns {Promise<RecoveryQueryAnswer>}
 */
async function internalQueryInstallationRecoverySource(capabilities, remotePath, recoveryRef) {
    let listedHead;
    try {
        // `-c safe.directory=*` avoids "detected dubious ownership" errors when
        // the remote is a local path with strict safe.directory enforcement.
        const lsRemoteResult = await capabilities.git.call(
            "-c", "safe.directory=*",
            "ls-remote", "--heads", "--", remotePath, recoveryRef
        );
        listedHead = lsRemoteResult.stdout.trim().split(/\s+/)[0] ?? '';
    } catch (error) {
        return {
            kind: 'indeterminate-or-error',
            reason: `recovery source could not be queried: ${error}`,
        };
    }

    if (listedHead === '') {
        return { kind: 'definitely-absent' };
    }
    if (!/^[0-9a-f]{40}$/.test(listedHead)) {
        return {
            kind: 'indeterminate-or-error',
            reason: `recovery source reported an unreadable published head: ${listedHead}`,
        };
    }

    const isHeld = await internalHoldPublishedHead(
        capabilities,
        remotePath,
        recoveryRef,
        listedHead
    );
    if (!isHeld) {
        return {
            kind: 'indeterminate-or-error',
            reason: `recovery source could not hold published head ${listedHead}`,
        };
    }
    return { kind: 'exists', publishedHead: listedHead };
}

/**
 * The continuation-safe-head test for the Git-backed transport.
 *
 * The transport publishes this installation's database through its
 * transport-managed remote branch, and a published branch which is still
 * treated as ordinary recoverable state is not silently rewound. Every copy of a
 * writer record which survived the loss of the local database therefore reached
 * a published head no later than the one this installation restores, so the
 * held published head is the frontier and the suffix lost with the database
 * cannot re-enter supported retained history.
 *
 * Executing that argument requires the source to actually hold the head it
 * reports: the checkpoint clone must exist and the reported commit must be
 * fetchable under exactly that identity. A head which moved while it was being
 * obtained is not the reported head, so it is not continuation-safe here.
 *
 * @param {GeneratorsCapabilities} capabilities
 * @param {string} remotePath
 * @param {string} recoveryRef
 * @param {string} publishedHead
 * @returns {Promise<boolean>}
 */
async function internalHoldPublishedHead(capabilities, remotePath, recoveryRef, publishedHead) {
    try {
        const checkpointGitDir = await workingRepository.getRepository(
            capabilities,
            CHECKPOINT_WORKING_PATH,
            { url: remotePath }
        );
        await capabilities.git.call(
            '-C', checkpointGitDir, '-c', 'safe.directory=*',
            'fetch', '--quiet', 'origin', recoveryRef
        );
        const fetchedHead = await capabilities.git.call(
            '-C', checkpointGitDir, '-c', 'safe.directory=*',
            'rev-parse', 'FETCH_HEAD^{commit}'
        );
        return fetchedHead.stdout.trim() === publishedHead;
    } catch (error) {
        capabilities.logger.logDebug(
            { publishedHead, error: String(error) },
            'Bootstrap: could not hold the reported published head'
        );
        return false;
    }
}

/**
 * Restore a completely absent installation from the published head the
 * recovery source held.
 *
 * This is a receiver-less restoration: the local storage and its writer
 * identity come from the held published snapshot, so it is reached only when no
 * local database exists. It authors no semantic event of its own.
 *
 * @param {GeneratorsCapabilities} capabilities
 * @param {RecoverySourceExists} recovery
 * @returns {Promise<void>}
 */
async function internalRestoreAbsentFrom(capabilities, recovery) {
    capabilities.logger.logInfo(
        { hostname: capabilities.environment.hostname(), publishedHead: recovery.publishedHead },
        'Bootstrap: installation recovery source reported a continuation-safe published head; restoring the absent installation'
    );
    // The transport binds receiver-less restoration to the installation's
    // published branch, which is exactly the branch the recovery source held.
    await synchronizeNoLock(capabilities, {
        resetToHostname: capabilities.environment.hostname(),
    });
    capabilities.logger.logInfo(
        { publishedHead: recovery.publishedHead },
        'Bootstrap: absent installation restored from the published head'
    );
}

/**
 * Decide and execute the absent-installation path when the live LevelDB is
 * absent.
 *
 * The decision is the recovery source's answer and nothing else: restore a
 * continuation-safe published head, create a fresh installation only on
 * definite absence, and fail when the answer is indeterminate. Normal
 * synchronization from an empty local database is not a recovery path, because
 * it would author a new identity over state whose recovery status is unknown.
 *
 * @param {GeneratorsCapabilities} capabilities
 * @returns {Promise<void>}
 */
async function internalBootstrap(capabilities) {
    const source = internalMakeInstallationRecoverySource(capabilities);
    const answer = await source.query();

    if (answer.kind === 'exists') {
        await internalRestoreAbsentFrom(capabilities, answer);
        return;
    }
    if (answer.kind === 'definitely-absent') {
        capabilities.logger.logInfo(
            {},
            'Bootstrap: installation recovery source reports definite absence; creating a fresh installation'
        );
        return;
    }
    throw new AbsentInstallationRecoveryError(answer.reason);
}

/**
 * @param {InterfaceLifecycleAccess} interfaceInstance
 * @param {(capabilities: GeneratorsCapabilities, database: RootDatabase, nodeDefs: Array<NodeDef>, callback: (storage: MigrationStorage) => Promise<void>) => Promise<RootDatabase>} runMigrationProcedure
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
        database = await runMigrationProcedure(
            capabilities,
            database,
            nodeDefs,
            migrationCallback(capabilities),
        );
        capabilities.logger.logDebug({}, 'Initialization: migration gate completed, constructing incremental graph');
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
        await synchronizeNoLock(capabilities, options);
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
    AbsentInstallationRecoveryError,
    isAbsentInstallationRecoveryError,
    internalEnsureInitialized,
    internalEnsureInitializedWithMigration,
    internalIsInitialized,
    internalRequireInitializedGraph,
    internalSynchronizeDatabase,
    internalSynchronizeDatabaseNoLock,
};
