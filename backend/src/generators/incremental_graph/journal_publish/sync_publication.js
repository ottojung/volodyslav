/**
 * The synchronization persistence front: publishing `Jfinal + project(Jfinal)` at cutover.
 *
 * `incremental-graph-journal-sync.md` §Atomic publication permits the transfer to stream
 * into inactive durable staging, with active state changing only at final cutover, and
 * requires that cutover to publish, together, `Jfinal`, `project(Jfinal)`, the local writer
 * allocator/high-water state and the derived indexes the implementation keeps. This module
 * is that publication for a synchronization. It never computes a synchronization:
 * `synchronizeRetainedJournal` in `../journal_sync` performs everything up to but excluding
 * the publication write and returns the outcome, and this module lowers that outcome the
 * way §Atomic publication lowers it. The lowering itself is `planSyncPublication`, because
 * a projection becomes persisted graph bytes in exactly one place in this tree and a second
 * copy of that lowering would be a second rule about what a projection persists.
 *
 * ## What this module adds to the shared lowering
 *
 * A synchronization's journal growth is a *delta*: `SyncOutcome.records` holds the imported
 * foreign records and the receiver-authored normalization records, not the receiver's
 * already-retained history. The activated replica retains that history, and synchronization
 * retains it rather than replacing it, so the target must hold it as well. Because that
 * retained history is history-sized, it is not folded into the cutover batch: it is staged
 * into the inactive target first, in bounded chunks, by `staged_records.js`, and the cutover
 * batch then publishes the graph and the metadata which make the staged target exactly
 * `Jfinal`. The target is inactive throughout staging, so the receiver exposes either its
 * old pair or the complete new one.
 *
 * The target's replica metadata is the receiver's own: version, graph scheme and
 * fingerprint. A synchronization receiver keeps its own writer identity and authors every
 * record it writes afterwards under that writer, so the target is installed under the
 * receiver's identity rather than adopting the source's.
 */

const { GRAPH_SCHEME_KEY } = require('../database');
const { planSyncPublication } = require('./sync_publish');
const { stageRetainedRecords } = require('./staged_records');
/** @typedef {import('../journal/errors').AnyJournalError} JournalError */
/** @typedef {import('../journal/records').JournalRecord} JournalRecord */
/** @typedef {import('../journal/types').JournalAuthor} JournalAuthor */
/** @typedef {import('../journal/oracle/record_source').JournalSource} JournalSource */
/** @typedef {import('../database/root_database').RootDatabase} RootDatabase */
/** @typedef {import('../database/root_database').ReplicaName} ReplicaName */
/** @typedef {import('../database/root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('../journal_sync').SyncOutcome} SyncOutcome */

const { appendRetainedStateOp } = require('../journal_store');

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
 * @typedef {object} SyncPublicationRequest
 * @property {SchemaStorage} target - The inactive replica the synchronization is built into.
 * @property {JournalSource} retainedSource - The activated replica's retained journal,
 *   read through its per-writer streaming readers, which synchronization retains rather
 *   than replaces.
 * @property {string} receiverVersion - The activated replica's persisted version.
 * @property {string} receiverGraphScheme - The activated replica's persisted graph scheme.
 * @property {string} receiverFingerprint - The activated replica's own writer identity.
 * @property {SyncOutcome} outcome - What `synchronizeRetainedJournal` computed.
 */

/**
 * Build the one atomic cutover batch which makes the staged target active as `Jfinal`.
 *
 * The receiver's retained records are not part of this batch: they are history-sized, so
 * `publishSyncReceiverOutcome` stages them into the inactive target first, in bounded
 * chunks, while the target is still inactive (`staged_records.js`). This batch carries
 * only the cutover's own state — the replica metadata, `project(Jfinal)` lowered to
 * storage, the committed-pair writer state and the maintained proof summary — so it is
 * graph-sized rather than history-sized. The pointer move follows it, so the receiver
 * exposes `Jfinal + project(Jfinal)` only once every staged record and this batch are
 * durable.
 *
 * @param {SyncPublicationRequest} request
 * @returns {Promise<Array<*>>}
 */
async function planSyncReceiverPublication(request) {
    const {
        target,
        receiverVersion,
        receiverGraphScheme,
        receiverFingerprint,
        outcome,
    } = request;
    const operations = [
        target.global.putOp('version', receiverVersion),
        target.global.putOp(GRAPH_SCHEME_KEY, receiverGraphScheme),
        target.global.putOp('fingerprint', receiverFingerprint),
        ...await planSyncPublication({ target, outcome }),
    ];
    const rejected = appendRetainedStateOp(target.journal, operations, outcome.retainedState);
    if (rejected !== undefined) {
        throw rejected;
    }
    return operations;
}

/**
 * Publish one synchronization outcome into the inactive replica.
 *
 * The receiver's retained records are streamed into the inactive target first, in bounded
 * chunks, and the cutover batch is then issued as one atomic write. The target is inactive
 * throughout, so a failure in either phase leaves the previously activated replica as the
 * receiver; a retry re-stages the same deterministic keys over any abandoned partial
 * stage. The caller performs the cutover itself, by moving the replica pointer, and only
 * after this returns.
 *
 * @param {SyncPublicationRequest} request
 * @returns {Promise<void>}
 */
async function publishSyncReceiverOutcome(request) {
    await stageRetainedRecords(
        request.target,
        request.retainedSource,
        (recordKey) => new SyncPublicationError(recordKey)
    );
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
