const path = require('path');
const { transaction } = require('../../../gitstore');
const {
    CHECKPOINT_WORKING_PATH,
    LIVE_DATABASE_WORKING_PATH,
} = require('./gitstore');
const { makeRootDatabase } = require('./root_database');
const { scanSublevelFromSnapshot } = require('./render');
const { requireValidFingerprint } = require('./fingerprint');

/** @typedef {import('./synchronize').Capabilities} Capabilities */
/** @typedef {import('./root_database').RootDatabase} RootDatabase */

/**
 * @param {Capabilities} capabilities
 * @param {RootDatabase} database
 * @param {string} workTree
 * @param {boolean} isExistingDb - Whether the live database already existed before this import.
 * @returns {Promise<boolean>}
 */
async function importResetSnapshotIntoDatabase(capabilities, database, workTree, isExistingDb) {
    const snapshotRoot = workTree;
    const rDir = path.join(snapshotRoot, 'kindtree', 'r');
    const nextReplica = database.otherReplicaName();

    const hasSnapshotReplicaDirectory = await capabilities.checker.directoryExists(rDir);

    const preImportFingerprint = database.getFingerprint();

    await scanSublevelFromSnapshot(capabilities, database, {
        snapshotRoot,
        targetSublevel: nextReplica,
        snapshotSublevel: 'r',
    });

    const targetGlobal = database.replicaGlobalSublevel(nextReplica);
    if (hasSnapshotReplicaDirectory) {
        requireValidFingerprint(
            await targetGlobal.get('fingerprint'),
            'rendered/r/global/fingerprint during reset import'
        );
    }

    if (isExistingDb) {
        await targetGlobal.put(
            'fingerprint',
            requireValidFingerprint(preImportFingerprint, 'pre-import live database')
        );
    }

    const previousReplica = database.currentReplicaName();
    await database.setCurrentReplicaPointer(nextReplica);
    return nextReplica !== previousReplica;
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

    const liveDbExisted = (await capabilities.checker.directoryExists(liveDatabasePath)) !== null;

    let database = await makeRootDatabase(
        capabilities,
        liveDatabasePath
    );

    try {
        const switchedReplica = await importResetSnapshotIntoDatabase(
            capabilities,
            database,
            workTree,
            liveDbExisted
        );
        if (switchedReplica) {
            await database.close();
            database = await makeRootDatabase(capabilities, liveDatabasePath);
        }
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
