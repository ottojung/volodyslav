const path = require('path');
const { transaction } = require('../../../gitstore');
const {
    CHECKPOINT_WORKING_PATH,
    DATABASE_SUBPATH,
    LIVE_DATABASE_WORKING_PATH,
} = require('./gitstore');
const { FORMAT_MARKER, makeRootDatabase } = require('./root_database');
const { scanFromFilesystem } = require('./render');

/** @typedef {import('./synchronize').Capabilities} Capabilities */
/** @typedef {import('./root_database').RootDatabase} RootDatabase */

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

module.exports = {
    synchronizeResetToHostname,
    InvalidSnapshotFormatError,
    isInvalidSnapshotFormatError,
    InvalidSnapshotReplicaError,
    isInvalidSnapshotReplicaError,
};
