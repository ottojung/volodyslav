const path = require('path');
const { transaction } = require('../../../gitstore');
const {
    CHECKPOINT_WORKING_PATH,
    DATABASE_SUBPATH,
    LIVE_DATABASE_WORKING_PATH,
} = require('./gitstore');
const { makeRootDatabase, LAST_NODE_INDEX_KEY } = require('./root_database');
const { scanFromFilesystem } = require('./render');
const { requireValidFingerprint } = require('./fingerprint');
const { IDENTIFIERS_KEY } = require('./identifier_lookup');
const { GRAPH_SCHEME_KEY } = require('./graph_scheme');
const { parseIdentifierLookup } = require('./sync_merge_identifier_lookup');
const { assertValidReplicaMaterializationState } = require('./sync_merge_validation');

/** @typedef {import('./synchronize').Capabilities} Capabilities */
/** @typedef {import('./root_database').RootDatabase} RootDatabase */
/** @typedef {import('../journal_publish').ResetReceiverToSnapshot} ResetReceiverToSnapshot */
/** @typedef {import('./root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./root_database').ReplicaName} ReplicaName */


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
 * Thrown when a receiver which retains Journal records is reset by a caller which
 * supplied no Journal reset.
 *
 * `incremental-graph-journal-reset.md` §Atomicity requires the receiver to end up
 * holding `Jreset + project(Jreset)` in one write. A reset of a Journal receiver without
 * the Journal reset operation cannot produce that pair, and adopting the snapshot's rows
 * directly would be the pre-Journal row adoption §Reset is not pre-Journal bootstrap
 * merge forbids. The reset therefore stops instead of exposing an unsupported state.
 *
 * The properties this class carries are:
 * - nothing beyond the refusal itself, which is reported against the operation the
 *   caller owes rather than against a snapshot or a replica.
 *
 * The proof of those properties is guaranteed by:
 * - `importResetSnapshotIntoDatabase`: it raises this only when the activated replica
 *   retains at least one Journal record and no Journal reset was supplied.
 */
class JournalResetFrontMissingError extends Error {
    /**
     */
    constructor() {
        super(
            'a reset of a receiver which retains Journal records was requested without a Journal ' +
                'reset, so the receiver cannot be exposed holding Jreset + project(Jreset)'
        );
        this.name = 'JournalResetFrontMissingError';
    }
}

/**
 * @param {unknown} object
 * @returns {object is JournalResetFrontMissingError}
 */
function isJournalResetFrontMissingError(object) {
    return object instanceof JournalResetFrontMissingError;
}

/**
 * @param {Capabilities} capabilities
 * @param {RootDatabase} database
 * @param {string} workTree
 * @param {boolean} isExistingDb - Whether the live database already existed before this import.
 * @param {ResetReceiverToSnapshot | undefined} journalReset - The Journal reset the
 *   lifecycle performs when the receiver retains records.
 * @returns {Promise<boolean>}
 */
async function importResetSnapshotIntoDatabase(capabilities, database, workTree, isExistingDb, journalReset) {
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

    const receiverReplica = database.currentReplicaName();

    // A receiver which retains Journal records is reset through the Journal: it adopts
    // the snapshot's state by retaining its own history, importing the snapshot's and
    // authoring the repairs which make its projection equal the snapshot's, and it
    // exposes the result in one write over the inactive replica. A receiver which
    // retains no Journal record has no retained history to retain and is a pre-Journal
    // installation, whose snapshot restoration is not a Journal 3 reset.
    const receiverStorage = database.schemaStorageForReplica(receiverReplica);
    if (await hasAnyKey(receiverStorage.journal)) {
        if (journalReset === undefined) {
            throw new JournalResetFrontMissingError();
        }
        return await journalReset({
            database,
            capabilities,
            receiver: receiverReplica,
            source: nextReplica,
        });
    }

    const targetStorage = database.schemaStorageForReplica(nextReplica);
    const hasGlobalRecords = await hasAnyKey(targetGlobal);
    const rawVersion = await targetGlobal.get('version');
    const hasVersion = rawVersion !== undefined;
    const hasGraphScheme = await targetGlobal.get(GRAPH_SCHEME_KEY) !== undefined;
    const rawLookup = await targetGlobal.get(IDENTIFIERS_KEY);
    const hasLookup = rawLookup !== undefined;
    const hasRecords = await hasGraphRecords(targetStorage);
    const rawLastNodeIndex = await targetGlobal.get(LAST_NODE_INDEX_KEY);
    const hasLastNodeIndex = rawLastNodeIndex !== undefined;
    const rawFingerprint = await targetGlobal.get('fingerprint');
    const hasFingerprint = rawFingerprint !== undefined;
    const genuinelyEmpty = !hasGlobalRecords && !hasRecords;
    const initialized = hasVersion && hasGraphScheme && hasLookup && hasLastNodeIndex && hasFingerprint;
    if (!genuinelyEmpty && !initialized) {
        throw new Error('reset snapshot is neither genuinely empty nor fully initialized');
    }
    if (initialized) {
        if (typeof rawVersion !== 'string') {
            throw new Error('reset snapshot version must be a string');
        }
        if (typeof rawLastNodeIndex !== 'number') {
            throw new Error('reset snapshot last_node_index must be a number');
        }
        requireValidFingerprint(rawFingerprint, 'reset snapshot fingerprint');
        const lookup = parseIdentifierLookup(rawLookup, 'reset snapshot');
        await assertValidReplicaMaterializationState(targetStorage, lookup, 'reset snapshot');
        // The snapshot carries the source replica's DatabaseFingerprint. When
        // the live database already existed, the activated replica's fingerprint
        // is rewritten to the pre-import receiver fingerprint: a reset receiver
        // keeps its own writer identity and authors every record it writes
        // afterwards under that writer, per
        // docs/specs/incremental-graph-journal-reset.md §Writer identity.
        // Adoption of the source writer happens if and only if the receiver is
        // completely absent, in which case `isExistingDb` is false and this
        // write-back does not run. Do not remove these writes as redundant: the
        // imported fingerprint is otherwise silently adopted and the receiver
        // authors under a foreign writer, which
        // incremental-graph-journal-theorems.md Law 8 forbids.
        if (isExistingDb) {
            await targetGlobal.put(
                'fingerprint',
                requireValidFingerprint(preImportFingerprint, 'pre-import live database')
            );
        }
    }

    const previousReplica = database.currentReplicaName();
    await database.setCurrentReplicaPointer(nextReplica);
    return nextReplica !== previousReplica;
}

/**
 * @param {Capabilities} capabilities
 * @param {string} workTree
 * @param {ResetReceiverToSnapshot | undefined} journalReset
 * @returns {Promise<void>}
 */
async function replaceLiveDatabaseWithResetSnapshot(capabilities, workTree, journalReset) {
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
            liveDbExisted,
            journalReset
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
 * @param {ResetReceiverToSnapshot | undefined} journalReset
 * @returns {Promise<void>}
 */
async function synchronizeResetToHostname(capabilities, remoteLocation, journalReset) {
    await transaction(
        capabilities,
        CHECKPOINT_WORKING_PATH,
        remoteLocation,
        async (store) => {
            const workTree = await store.getWorkTree();
            await replaceLiveDatabaseWithResetSnapshot(
                capabilities,
                workTree,
                journalReset
            );
        }
    );
}

module.exports = {
    JournalResetFrontMissingError,
    isJournalResetFrontMissingError,
    synchronizeResetToHostname,
};
