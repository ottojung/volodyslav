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
const { transaction, configureRemoteForAllBranches, defaultBranch } = gitstore;
const { listRemoteBranches } = gitstore.mergeHostBranches;
const workingRepository = gitstore.workingRepository;
const { parseRemoteHostnameBranch } = require('../../../hostname');
const {
    checkpointDatabase,
    CHECKPOINT_WORKING_PATH,
    DATABASE_SUBPATH,
    LIVE_DATABASE_WORKING_PATH,
} = require('./gitstore');
const { FORMAT_MARKER, makeRootDatabase } = require('./root_database');
const { scanFromFilesystem } = require('./render');
const { getRootDatabase } = require('./get_root_database');
const {
    mergeHostIntoReplica,
    SyncMergeAggregateError,
    isSyncMergeAggregateError,
} = require('./sync_merge');

/**
 * Thrown when the snapshot's `_meta/current_replica` file is missing a valid
 * replica name ("x" or "y"). This indicates a corrupted or incompatible snapshot.
 */
class InvalidSnapshotReplicaError extends Error {
    /**
     * @param {unknown} value - The invalid value that was read.
     * @param {string} filePath - Path to the file that contained the bad value.
     */
    constructor(value, filePath) {
        const renderedValue = value === undefined ? 'undefined' : JSON.stringify(value);
        super(
            `Snapshot _meta/current_replica has invalid value: ${renderedValue}. Expected "x" or "y". File: ${filePath}`
        );
        this.name = 'InvalidSnapshotReplicaError';
        this.value = value;
        this.filePath = filePath;
    }
}

/**
 * Thrown when the snapshot's `_meta/format` marker is missing or incompatible.
 */
class InvalidSnapshotFormatError extends Error {
    /**
     * @param {unknown} value - The invalid value that was read.
     * @param {string} filePath - Path to the file that contained the bad value.
     */
    constructor(value, filePath) {
        const renderedValue = value === undefined ? 'undefined' : JSON.stringify(value);
        super(
            `Snapshot _meta/format has invalid value: ${renderedValue}. Expected ${JSON.stringify(FORMAT_MARKER)}. File: ${filePath}`
        );
        this.name = 'InvalidSnapshotFormatError';
        this.value = value;
        this.filePath = filePath;
    }
}

/**
 * @param {unknown} object
 * @returns {object is InvalidSnapshotReplicaError}
 */
function isInvalidSnapshotReplicaError(object) {
    return object instanceof InvalidSnapshotReplicaError;
}

/**
 * @param {unknown} object
 * @returns {object is InvalidSnapshotFormatError}
 */
function isInvalidSnapshotFormatError(object) {
    return object instanceof InvalidSnapshotFormatError;
}

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
 * @param {string} filePath
 * @returns {Promise<unknown>}
 */
async function readJsonFromFile(capabilities, filePath) {
    const content = await capabilities.reader.readFileAsText(filePath);
    return JSON.parse(content);
}

/**
 * @param {Capabilities} capabilities
 * @param {string} snapshotMetaDir
 * @returns {Promise<'x' | 'y'>}
 */
async function validateResetSnapshotMetadata(capabilities, snapshotMetaDir) {
    const formatFile = path.join(snapshotMetaDir, 'format');
    if (!(await capabilities.checker.fileExists(formatFile))) {
        throw new InvalidSnapshotFormatError(undefined, formatFile);
    }

    let parsedFormat;
    try {
        parsedFormat = await readJsonFromFile(capabilities, formatFile);
    } catch {
        const formatRaw = await capabilities.reader.readFileAsText(formatFile);
        throw new InvalidSnapshotFormatError(formatRaw, formatFile);
    }
    if (parsedFormat !== FORMAT_MARKER) {
        throw new InvalidSnapshotFormatError(parsedFormat, formatFile);
    }

    const currentReplicaFile = path.join(snapshotMetaDir, 'current_replica');
    if (!(await capabilities.checker.fileExists(currentReplicaFile))) {
        throw new InvalidSnapshotReplicaError(undefined, currentReplicaFile);
    }

    let parsedReplica;
    try {
        parsedReplica = await readJsonFromFile(capabilities, currentReplicaFile);
    } catch {
        const replicaRaw = await capabilities.reader.readFileAsText(currentReplicaFile);
        throw new InvalidSnapshotReplicaError(replicaRaw, currentReplicaFile);
    }
    if (parsedReplica !== 'x' && parsedReplica !== 'y') {
        throw new InvalidSnapshotReplicaError(parsedReplica, currentReplicaFile);
    }

    return parsedReplica;
}

/**
 * @param {Capabilities} capabilities
 * @param {RootDatabase} database
 * @param {string} workTree
 * @param {'x' | 'y'} snapshotReplica
 * @returns {Promise<void>}
 */
async function importResetSnapshotIntoDatabase(capabilities, database, workTree, snapshotReplica) {
    const snapshotRoot = path.join(workTree, DATABASE_SUBPATH);
    const snapshotMetaDir = path.join(snapshotRoot, '_meta');
    const rDir = path.join(snapshotRoot, 'r');

    if (await capabilities.checker.directoryExists(rDir)) {
        await scanFromFilesystem(
            capabilities,
            database,
            rDir,
            snapshotReplica
        );
    } else {
        await database._rawDeleteSublevel(snapshotReplica);
    }

    await scanFromFilesystem(
        capabilities,
        database,
        snapshotMetaDir,
        '_meta'
    );
}

/**
 * @param {Capabilities} capabilities
 * @param {string} workTree
 * @param {'x' | 'y'} snapshotReplica
 * @returns {Promise<void>}
 */
async function replaceLiveDatabaseWithResetSnapshot(capabilities, workTree, snapshotReplica) {
    const workingDirectory = capabilities.environment.workingDirectory();
    const liveDatabasePath = path.join(
        workingDirectory,
        LIVE_DATABASE_WORKING_PATH
    );
    const resetWorkspace = await capabilities.creator.createTemporaryDirectory(
        workingDirectory
    );
    const stagedDatabasePath = path.join(
        resetWorkspace,
        LIVE_DATABASE_WORKING_PATH
    );
    const backupDatabasePath = path.join(
        resetWorkspace,
        `${LIVE_DATABASE_WORKING_PATH}-backup`
    );

    /** @type {RootDatabase | undefined} */
    let stagedDatabase;
    let movedLiveToBackup = false;

    try {
        stagedDatabase = await makeRootDatabase(
            capabilities,
            stagedDatabasePath
        );
        await importResetSnapshotIntoDatabase(
            capabilities,
            stagedDatabase,
            workTree,
            snapshotReplica
        );
        await stagedDatabase.close();
        stagedDatabase = undefined;

        if (await capabilities.checker.directoryExists(liveDatabasePath)) {
            await capabilities.mover.moveDirectory(
                liveDatabasePath,
                backupDatabasePath
            );
            movedLiveToBackup = true;
        }

        try {
            await capabilities.mover.moveDirectory(
                stagedDatabasePath,
                liveDatabasePath
            );
        } catch (moveError) {
            if (movedLiveToBackup) {
                await capabilities.mover.moveDirectory(
                    backupDatabasePath,
                    liveDatabasePath
                );
            }
            throw moveError;
        }

        if (movedLiveToBackup) {
            await capabilities.deleter.deleteDirectory(backupDatabasePath);
        }
    } finally {
        if (stagedDatabase !== undefined) {
            await stagedDatabase.close();
        }
        if (await capabilities.checker.directoryExists(resetWorkspace)) {
            await capabilities.deleter.deleteDirectory(resetWorkspace);
        }
    }
}

/**
 * @param {Capabilities} capabilities
 * @param {{ url: string }} remoteLocation
 * @returns {Promise<void>}
 */
async function synchronizeResetToHostname(capabilities, remoteLocation) {
    await transaction(
        capabilities,
        CHECKPOINT_WORKING_PATH,
        remoteLocation,
        async (store) => {
            const workTree = await store.getWorkTree();
            const snapshotMetaDir = path.join(workTree, DATABASE_SUBPATH, '_meta');
            const snapshotReplica = await validateResetSnapshotMetadata(
                capabilities,
                snapshotMetaDir
            );
            await replaceLiveDatabaseWithResetSnapshot(
                capabilities,
                workTree,
                snapshotReplica
            );
        }
    );
}

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
    InvalidSnapshotFormatError,
    isInvalidSnapshotFormatError,
    InvalidSnapshotReplicaError,
    isInvalidSnapshotReplicaError,
    isSyncMergeAggregateError,
};
