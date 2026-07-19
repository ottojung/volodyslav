const path = require('path');
const { transaction } = require('../../../gitstore');
const {
    CHECKPOINT_WORKING_PATH,
    DATABASE_SUBPATH,
    LIVE_DATABASE_WORKING_PATH,
} = require('./gitstore');
const { makeRootDatabase } = require('./root_database');
const { scanFromFilesystem } = require('./render');
const { requireValidFingerprint } = require('./fingerprint');
const { IDENTIFIERS_KEY, makeEmptyIdentifierLookup } = require('./identifier_lookup');
const { GRAPH_SCHEME_KEY } = require('./graph_scheme');
const { parseIdentifierLookup } = require('./sync_merge_identifier_lookup');
const { assertValidReplicaMaterializationState } = require('./sync_merge_validation');

/** @typedef {import('./synchronize').Capabilities} Capabilities */
/** @typedef {import('./root_database').RootDatabase} RootDatabase */


/**
 * @param {{ keys: () => AsyncIterable<unknown> }} sublevel
 * @returns {Promise<boolean>}
 */
async function hasAnyKey(sublevel) {
    for await (const _key of sublevel.keys()) {
        return true;
    }
    return false;
}

/**
 * @param {import('./root_database').SchemaStorage} storage
 * @returns {Promise<boolean>}
 */
async function hasGraphRecords(storage) {
    return await hasAnyKey(storage.values)
        || await hasAnyKey(storage.freshness)
        || await hasAnyKey(storage.timestamps)
        || await hasAnyKey(storage.valid);
}

/**
 * @param {Capabilities} capabilities
 * @param {RootDatabase} database
 * @param {string} workTree
 * @param {boolean} isExistingDb - Whether the live database already existed before this import.
 * @returns {Promise<boolean>}
 */
async function importResetSnapshotIntoDatabase(capabilities, database, workTree, isExistingDb) {
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

    const preImportFingerprint = database.getFingerprint();

    await scanFromFilesystem(
        capabilities,
        database,
        importDirectory,
        nextReplica
    );

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

    const targetStorage = database.schemaStorageForReplica(nextReplica);
    const hasVersion = await targetGlobal.get('version') !== undefined;
    const hasGraphScheme = await targetGlobal.get(GRAPH_SCHEME_KEY) !== undefined;
    const rawLookup = await targetGlobal.get(IDENTIFIERS_KEY);
    const hasLookup = rawLookup !== undefined;
    const hasRecords = await hasGraphRecords(targetStorage);
    const genuinelyEmpty = !hasVersion && !hasGraphScheme && !hasLookup && !hasRecords;
    const initialized = hasVersion && hasGraphScheme;
    if (!genuinelyEmpty && !initialized) {
        throw new Error('reset snapshot is neither genuinely empty nor fully initialized');
    }
    if (initialized) {
        const lookup = hasLookup
            ? parseIdentifierLookup(rawLookup, 'reset snapshot')
            : makeEmptyIdentifierLookup();
        await assertValidReplicaMaterializationState(targetStorage, lookup, 'reset snapshot');
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
