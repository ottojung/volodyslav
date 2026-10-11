/**
 * The synchronization persistence front: publishing `Jfinal + project(Jfinal)` in one write.
 *
 * `incremental-graph-journal-sync.md` §Atomic publication requires that cutover publish,
 * together, `Jfinal`, `project(Jfinal)`, the local writer allocator/high-water state and
 * the derived indexes the implementation keeps. This module is that write for a
 * synchronization. It never computes a synchronization: `synchronizeRetainedJournal` in
 * `../journal_sync` performs everything up to but excluding the publication write and
 * returns the outcome, and this module lowers that outcome the way
 * `incremental-graph-journal-sync.md` §Atomic publication lowers it. The lowering itself is
 * `planSyncPublication`, because a projection becomes persisted graph bytes in exactly one
 * place in this tree and a second copy of that lowering would be a second rule about what a
 * projection persists.
 *
 * ## What this module adds to the shared lowering
 *
 * A synchronization's journal growth is a *delta*: `SyncOutcome.records` holds the imported
 * foreign records and the receiver-authored normalization records, not the receiver's
 * already-retained history. The activated replica retains that history, and synchronization
 * retains it rather than replacing it, so the target must hold it as well. The retained
 * records are therefore written alongside the outcome's own records in the same batch, which
 * makes the target sublevel exactly `Jfinal` when the batch completes.
 *
 * The target's replica metadata is the receiver's own: version, graph scheme and
 * fingerprint. A synchronization receiver keeps its own writer identity and authors every
 * record it writes afterwards under that writer, so the target is installed under the
 * receiver's identity rather than adopting the source's.
 */

const {
    GRAPH_SCHEME_KEY,
    stringToJournalText,
} = require('../database');
const { planSyncPublication } = require('./sync_publish');
/** @typedef {import('../journal/errors').AnyJournalError} JournalError */
/** @typedef {import('../journal/records').JournalRecord} JournalRecord */
/** @typedef {import('../journal/types').JournalAuthor} JournalAuthor */
/** @typedef {import('../database/root_database').RootDatabase} RootDatabase */
/** @typedef {import('../database/root_database').ReplicaName} ReplicaName */
/** @typedef {import('../database/root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('../journal_sync').SyncOutcome} SyncOutcome */

const {
    encodeJournalRecord,
    journalAuthorToString,
} = require('../journal');
const { makeJournalRecordKey } = require('../journal_store');

/**
 * Thrown when a synchronization outcome cannot be lowered into the replica namespace it
 * targets.
 *
 * The properties this class carries are:
 * - `recordKey` names the coordinate whose storage key the Journal sublevel rejected,
 *   so the failure is reported against the record which caused it.
 *
 * The proof of those properties is guaranteed by:
 * - `planSyncReceiverPublication(...)`: it reports a coordinate only when
 *   `makeJournalRecordKey` returns an error for that record's own author and
 *   sequence, and `makeJournalRecordKey` returns an error only for a coordinate
 *   wider than the sublevel's key width.
 *
 * @param {string} recordKey
 */
class SyncPublicationError extends Error {
    /**
     * @param {string} recordKey
     */
    constructor(recordKey) {
        super('the synchronization cannot be lowered: record ' + recordKey + ' has no storage key');
        this.name = 'SyncPublicationError';
        this.recordKey = recordKey;
    }
}

/**
 * @param {unknown} object
 * @returns {object is SyncPublicationError}
 */
function isSyncPublicationError(object) {
    return object instanceof SyncPublicationError;
}

/**
 * The operations which retain the receiver's already committed journal records in the target
 * replica.
 *
 * A record's storage key is its author and coordinate, so writing the receiver's own
 * retained records into the target contributes exactly the keys `Jfinal` names for them and
 * nothing else. Occurrence keys are not written here: the shared lowering derives the
 * occurrence index from the projection it lowers, so the target's index names
 * `project(Jfinal)` and not the receiver's pre-synchronization occurrences.
 *
 * @param {SchemaStorage} target
 * @param {ReadonlyArray<JournalRecord>} retainedRecords
 * @returns {Array<*>}
 */
function retainedRecordOperations(target, retainedRecords) {
    /** @type {Array<*>} */
    const operations = [];
    for (const record of retainedRecords) {
        const key = makeJournalRecordKey(record.id.author, record.id.sequence);
        if (key instanceof Error) {
            throw new SyncPublicationError(journalAuthorToString(record.id.author));
        }
        operations.push(target.journal.putOp(key, stringToJournalText(encodeJournalRecord(record))));
    }
    return operations;
}

/**
 * @typedef {object} SyncPublicationRequest
 * @property {SchemaStorage} target - The inactive replica the synchronization is built into.
 * @property {ReadonlyArray<JournalRecord>} retainedRecords - The activated replica's
 *   retained journal, which synchronization retains rather than replaces.
 * @property {string} receiverVersion - The activated replica's persisted version.
 * @property {string} receiverGraphScheme - The activated replica's persisted graph scheme.
 * @property {string} receiverFingerprint - The activated replica's own writer identity.
 * @property {SyncOutcome} outcome - What `synchronizeRetainedJournal` computed.
 */

/**
 * Build the one operation array which turns the inactive replica into `Jfinal`.
 *
 * @param {SyncPublicationRequest} request
 * @returns {Promise<Array<*>>}
 */
async function planSyncReceiverPublication(request) {
    const {
        target,
        retainedRecords,
        receiverVersion,
        receiverGraphScheme,
        receiverFingerprint,
        outcome,
    } = request;
    return [
        ...retainedRecordOperations(target, retainedRecords),
        target.global.putOp('version', receiverVersion),
        target.global.putOp(GRAPH_SCHEME_KEY, receiverGraphScheme),
        target.global.putOp('fingerprint', receiverFingerprint),
        ...await planSyncPublication({ target, outcome }),
    ];
}

/**
 * Publish one synchronization outcome into the inactive replica.
 *
 * The whole publication is one array of operations and one `batch` call, so the target
 * never exposes a journal which disagrees with its own graph: either `Jfinal` and
 * `project(Jfinal)` both become visible together or neither does. The caller performs
 * the cutover itself, by moving the replica pointer, and only after this returns.
 *
 * @param {SyncPublicationRequest} request
 * @returns {Promise<void>}
 */
async function publishSyncReceiverOutcome(request) {
    await request.target.batch(await planSyncReceiverPublication(request));
}

/**
 * @typedef {object} InstallSyncRequest
 * @property {RootDatabase} rootDatabase - The opened root database, whose replica
 *   pointer this moves once the publication has succeeded.
 * @property {ReplicaName} targetReplica - The inactive replica the synchronization is
 *   built into.
 * @property {SyncPublicationRequest} publication - The publication itself.
 */

/**
 * Publish a synchronization outcome and cut the receiver over to it.
 *
 * A rejected publication throws before the pointer moves, which leaves the previously
 * activated replica as the receiver's exposed state.
 *
 * @param {InstallSyncRequest} request
 * @returns {Promise<ReplicaName>}
 */
async function installSyncOutcome(request) {
    await publishSyncReceiverOutcome(request.publication);
    await request.rootDatabase.setCurrentReplicaPointer(request.targetReplica);
    return request.targetReplica;
}

module.exports = {
    SyncPublicationError,
    installSyncOutcome,
    isSyncPublicationError,
    planSyncReceiverPublication,
    publishSyncReceiverOutcome,
};
