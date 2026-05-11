/**
 * Synchronization module for the incremental-graph LevelDB database.
 *
 * Renders the current live database into the tracked filesystem snapshot,
 * pushes our branch to the remote generators repository, then performs a
 * structured, per-host graph merge using the incremental-graph merge engine
 * instead of git-level textual merges.
 *
 * Callers are responsible for acquiring a lock around this call so that
 * LevelDB is not written to while synchronization is in progress.
 */

const gitstore = require('../../../gitstore');
const path = require('path');
const { configureRemoteForAllBranches, defaultBranch } = gitstore;
const { listRemoteBranches } = gitstore.mergeHostBranches;
const workingRepository = gitstore.workingRepository;
const { parseRemoteHostnameBranch } = require('../../../hostname');
const {
    checkpointDatabase,
    CHECKPOINT_WORKING_PATH,
    DATABASE_SUBPATH,
} = require('./gitstore');
const {
    synchronizeResetToHostname,
} = require('./synchronize_reset_snapshot');
const { scanFromFilesystem } = require('./render');
const { getRootDatabase } = require('./get_root_database');
const {
    mergeHostIntoReplica,
    SyncMergeAggregateError,
    isSyncMergeAggregateError,
} = require('./sync_merge');

/** @typedef {import('../../../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../../../filesystem/mover').FileMover} FileMover */
/** @typedef {import('../../../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../../../filesystem/deleter').FileDeleter} FileDeleter */
/** @typedef {import('../../../filesystem/reader').FileReader} FileReader */
/** @typedef {import('../../../filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('../../../filesystem/dirscanner').DirScanner} DirScanner */
/** @typedef {import('../../../logger').Logger} Logger */
/** @typedef {import('../../../environment').Environment} Environment */
/** @typedef {import('../../../datetime').Datetime} Datetime */
/** @typedef {import('../../../sleeper').SleepCapability} SleepCapability */
/** @typedef {import('../../../subprocess/command').Command} Command */
/** @typedef {import('../../../level_database').LevelDatabase} LevelDatabase */
/** @typedef {import('../../../generators/interface').Interface} Interface */
/** @typedef {import('./root_database').RootDatabase} RootDatabase */

/**
 * @typedef {object} Capabilities
 * @property {Command} git
 * @property {FileCreator} creator
 * @property {FileDeleter} deleter
 * @property {FileChecker} checker
 * @property {FileMover} mover
 * @property {FileWriter} writer
 * @property {FileReader} reader
 * @property {DirScanner} scanner
 * @property {Environment} environment
 * @property {Logger} logger
 * @property {SleepCapability} sleeper
 * @property {Datetime} datetime
 * @property {Interface} interface
 * @property {LevelDatabase} levelDatabase
 */

/**
 * @param {Capabilities} capabilities
 * @param {RootDatabase} rootDatabase
 * @returns {Promise<void>}
 */
async function mergeRemoteHostBranches(capabilities, rootDatabase) {
    const workDir = path.join(
        capabilities.environment.workingDirectory(),
        CHECKPOINT_WORKING_PATH
    );

    await configureRemoteForAllBranches(capabilities, workDir);
    await capabilities.git.call(
        '-C', workDir, '-c', 'safe.directory=*',
        'fetch', 'origin'
    );

    const remoteBranches = await listRemoteBranches(capabilities, workDir);
    const ourBranch = defaultBranch(capabilities);

    /** @type {Map<string, { hostname: string, message: string }>} */
    const failuresByHost = new Map();

    /**
     * @param {string} hostname
     * @param {string} message
     * @param {boolean} isCleanupFailure
     */
    const recordHostFailure = (hostname, message, isCleanupFailure) => {
        const existing = failuresByHost.get(hostname);
        if (existing === undefined) {
            failuresByHost.set(hostname, { hostname, message });
            return;
        }
        if (isCleanupFailure) {
            existing.message = `${existing.message}; cleanup: ${message}`;
            return;
        }
        failuresByHost.set(hostname, { hostname, message });
    };

    for (const remoteBranch of remoteBranches) {
        const hostname = parseRemoteHostnameBranch(remoteBranch);
        if (hostname === null || remoteBranch === `origin/${ourBranch}`) {
            continue;
        }

        let tmpDir;
        let worktreeAdded = false;
        try {
            tmpDir = await capabilities.creator.createTemporaryDirectory();
            await capabilities.git.call(
                '-C', workDir, '-c', 'safe.directory=*',
                'worktree', 'add', '--detach', tmpDir, remoteBranch
            );
            worktreeAdded = true;


            const remoteRDir = path.join(tmpDir, DATABASE_SUBPATH, 'r');
            await scanFromFilesystem(
                capabilities,
                rootDatabase,
                remoteRDir,
                '_h_' + hostname
            );
            await mergeHostIntoReplica(capabilities.logger, rootDatabase, hostname);

            capabilities.logger.logInfo(
                { hostname },
                'Successfully merged host branch'
            );
        } catch (err) {
            recordHostFailure(
                hostname,
                err instanceof Error ? err.message : String(err),
                false
            );
            capabilities.logger.logInfo(
                { hostname, error: err },
                'Failed to merge host branch; continuing with remaining hosts'
            );
        } finally {
            if (worktreeAdded && tmpDir !== undefined) {
                try {
                    await capabilities.git.call(
                        '-C', workDir, '-c', 'safe.directory=*',
                        'worktree', 'remove', '--force', tmpDir
                    );
                } catch (cleanupErr) {
                    capabilities.logger.logInfo(
                        { hostname, error: cleanupErr },
                        'Failed to remove worktree during cleanup'
                    );
                    try {
                        await capabilities.deleter.deleteDirectory(tmpDir);
                    } catch {
                        // Ignore secondary cleanup failures.
                    }
                }
            } else if (tmpDir !== undefined) {
                try {
                    await capabilities.deleter.deleteDirectory(tmpDir);
                } catch {
                    // Ignore cleanup failures.
                }
            }

            try {
                await rootDatabase.clearHostnameStorage(hostname);
            } catch (cleanupErr) {
                recordHostFailure(
                    hostname,
                    cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
                    true
                );
                capabilities.logger.logInfo(
                    { hostname, error: cleanupErr },
                    'Failed to clear hostname storage during cleanup'
                );
            }
        }
    }

    const failures = [...failuresByHost.values()];
    if (failures.length > 0) {
        throw new SyncMergeAggregateError(failures);
    }
}

/**
 * Checkpoint the database and synchronize it with the remote generators repository.
 *
 * The caller must ensure the database is locked (not written to) for the
 * duration of this call.
 *
 * @param {Capabilities} capabilities
 * @param {{ resetToHostname?: string }} [options]
 * @return {Promise<void>}
 * @throws {import('../../../gitstore/working_repository').WorkingRepositoryError} If git sync fails
 * @throws {SyncMergeAggregateError} If one or more per-host graph merges fail
 */
async function synchronizeNoLock(capabilities, options) {
    const remotePath = capabilities.environment.generatorsRepository();
    const remoteLocation = { url: remotePath };

    if (options?.resetToHostname !== undefined) {
        await workingRepository.synchronize(
            capabilities,
            CHECKPOINT_WORKING_PATH,
            remoteLocation,
            { ...options, mergeHostBranches: false }
        );
        await synchronizeResetToHostname(capabilities, remoteLocation);
        capabilities.logger.logInfo(
            { remotePath, options },
            'Synchronized generators database with remote'
        );
        return;
    }

    /** @type {RootDatabase | undefined} */
    let rootDatabase;
    try {
        rootDatabase = await getRootDatabase(capabilities);
        await checkpointDatabase(
            capabilities,
            'sync checkpoint',
            rootDatabase,
            remoteLocation
        );
        await workingRepository.synchronize(
            capabilities,
            CHECKPOINT_WORKING_PATH,
            remoteLocation,
            { ...options, mergeHostBranches: false }
        );

        await mergeRemoteHostBranches(capabilities, rootDatabase);
    } finally {
        if (rootDatabase !== undefined) {
            await rootDatabase.close();
        }
    }

    capabilities.logger.logInfo(
        { remotePath, options },
        'Synchronized generators database with remote'
    );
}

module.exports = {
    synchronizeNoLock,
    isSyncMergeAggregateError,
};
