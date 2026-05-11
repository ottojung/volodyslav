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
    const nextReplica = database.otherReplicaName();

    const hasSnapshotReplicaDirectory = await capabilities.checker.directoryExists(rDir);
    const importDirectory = hasSnapshotReplicaDirectory
        ? rDir
        : path.join(workTree, DATABASE_SUBPATH, '_empty_reset_snapshot');

    if (!hasSnapshotReplicaDirectory) {
        await capabilities.creator.createDirectory(importDirectory);
    }

    await scanFromFilesystem(
        capabilities,
        database,
        importDirectory,
        nextReplica
    );

    await database.switchToReplica(nextReplica);
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

    const database = await makeRootDatabase(
        capabilities,
        liveDatabasePath
    );

    try {
        await importResetSnapshotIntoDatabase(
            capabilities,
            database,
            workTree
        );
    } finally {
        await database.close();
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
