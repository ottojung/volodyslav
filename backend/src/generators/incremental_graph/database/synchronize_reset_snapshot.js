const path = require('path');
const { transaction } = require('../../../gitstore');
const {
    CHECKPOINT_WORKING_PATH,
    DATABASE_SUBPATH,
    LIVE_DATABASE_WORKING_PATH,
} = require('./gitstore');
const { makeRootDatabase } = require('./root_database');
const { scanFromFilesystem } = require('./render');

/** @typedef {import('./synchronize').Capabilities} Capabilities */
/** @typedef {import('./root_database').RootDatabase} RootDatabase */

/**
 * @param {Capabilities} capabilities
 * @param {RootDatabase} database
 * @param {string} workTree
 * @returns {Promise<void>}
 */
async function importResetSnapshotIntoDatabase(capabilities, database, workTree) {
    const snapshotRoot = path.join(workTree, DATABASE_SUBPATH);
    const rDir = path.join(snapshotRoot, 'r');
    const targetReplica = 'x';

    if (await capabilities.checker.directoryExists(rDir)) {
        await scanFromFilesystem(
            capabilities,
            database,
            rDir,
            targetReplica
        );
    } else {
        await database._rawDeleteSublevel(targetReplica);
    }

    await database.switchToReplica(targetReplica);
}

/**
 * @param {Capabilities} capabilities
 * @param {string} workTree
 * @returns {Promise<void>}
 */
async function replaceLiveDatabaseWithResetSnapshot(capabilities, workTree) {
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
            workTree
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
            await replaceLiveDatabaseWithResetSnapshot(
                capabilities,
                workTree
            );
        }
    );
}

module.exports = {
    synchronizeResetToHostname,
};
