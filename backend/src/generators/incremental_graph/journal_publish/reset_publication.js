/**
 * The reset persistence front: publishing `Jreset + project(Jreset)` in one write.
 *
 * `incremental-graph-journal-reset.md` §Atomicity requires that a reset construct
 * `J0` and its repairs in inactive storage, that the receiver expose either
 * `old journal + old graph` or `Jreset + project(Jreset)` and never a split or
 * intermediate state, and that a failure before cutover leave the previous supported
 * receiver active. All three are one statement about a single write: everything reset
 * produces lands in one `SchemaStorage.batch` over the inactive replica, and the replica
 * pointer moves only after that batch has succeeded. A failure anywhere before the
 * pointer move leaves the activated replica exactly as it was, which is the state
 * §Atomicity requires a failed reset to leave behind.
 *
 * This module is that write. It never computes a reset: `resetToSource` in
 * `../journal_reset` performs everything up to but excluding the publication write and
 * returns the outcome, and this module lowers that outcome the way
 * `incremental-graph-journal-sync.md` §Atomic publication lowers a synchronization
 * outcome. The lowering itself is `planSyncPublication`, because a projection becomes
 * persisted graph bytes in exactly one place in this tree and a second copy of that
 * lowering would be a second rule about what a projection persists.
 *
 * ## What this module adds to the shared lowering
 *
 * A reset's journal growth is a *delta*: `ResetOutcome.records` holds the imported
 * source records and the receiver-authored reset records, not the receiver's already
 * retained history. The activated replica retains that history, and reset retains it
 * rather than replacing it, so the target must hold it as well. Because that retained
 * history is history-sized, it is not folded into the cutover batch: it is staged into
 * the inactive target first, in bounded chunks, by `staged_records.js`, and the cutover
 * batch then publishes the graph and the metadata which make the staged target exactly
 * `Jreset`. The target is inactive throughout staging, so the receiver exposes either its
 * old pair or the complete new one.
 *
 * The target's replica metadata is the receiver's own: version, graph scheme and
 * fingerprint. A reset receiver keeps its own writer identity and authors every record
 * it writes afterwards under that writer, per
 * `incremental-graph-fingerprint.md`, so the target is installed under the
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
/** @typedef {import('../journal_reset').ResetOutcome} ResetOutcome */

const { appendRetainedStateOp } = require('../journal_store');

/**
 * Thrown when a reset outcome cannot be lowered into the replica namespace it targets.
 *
 * The properties this class carries are:
 * - `recordKey` names the coordinate whose storage key the Journal sublevel rejected,
 *   so the failure is reported against the record which caused it.
 *
 * The proof of those properties is guaranteed by:
 * - `planResetPublication(...)`: it reports a coordinate only when
 *   `makeJournalRecordKey` returns an error for that record's own author and
 *   sequence, and `makeJournalRecordKey` returns an error only for a coordinate
 *   wider than the sublevel's key width.
 *
 * @param {string} recordKey
 */
class ResetPublicationError extends Error {
    /**
     * @param {string} recordKey
     */
    constructor(recordKey) {
        super('the reset cannot be lowered: record ' + recordKey + ' has no storage key');
        this.name = 'ResetPublicationError';
        this.recordKey = recordKey;
    }
}

/**
 * @param {unknown} object
 * @returns {object is ResetPublicationError}
 */
function isResetPublicationError(object) {
    return object instanceof ResetPublicationError;
}

/**
 * @typedef {object} ResetPublicationRequest
 * @property {SchemaStorage} target - The inactive replica the reset is built into.
 * @property {JournalSource} retainedSource - The activated replica's retained journal,
 *   read through its per-writer streaming readers, which reset retains rather than
 *   replaces.
 * @property {string} receiverVersion - The activated replica's persisted version.
 * @property {string} receiverGraphScheme - The activated replica's persisted graph
 *   scheme.
 * @property {string} receiverFingerprint - The activated replica's own writer identity.
 * @property {ResetOutcome} outcome - What `resetToSource` computed.
 */

/**
 * Build the one atomic cutover batch which makes the staged target active as `Jreset`.
 *
 * The receiver's retained records are not part of this batch: they are history-sized, so
 * `publishResetOutcome` stages them into the inactive target first, in bounded chunks,
 * while the target is still inactive (`staged_records.js`). This batch carries only the
 * cutover's own state — the replica metadata, `project(Jreset)` lowered to storage, the
 * committed-pair writer state and the maintained proof summary — so it is graph-sized
 * rather than history-sized. The pointer move follows it, so the receiver exposes
 * `Jreset + project(Jreset)` only once every staged record and this batch are durable.
 *
 * @param {ResetPublicationRequest} request
 * @returns {Promise<Array<*>>}
 */
async function planResetPublication(request) {
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
 * Publish one reset outcome into the inactive replica.
 *
 * The receiver's retained records are streamed into the inactive target first, in bounded
 * chunks, and the cutover batch is then issued as one atomic write. The target is inactive
 * throughout, so a failure in either phase leaves the previously activated replica as the
 * receiver; a retry re-stages the same deterministic keys over any abandoned partial
 * stage. The caller performs the cutover itself, by moving the replica pointer, and only
 * after this returns.
 *
 * @param {ResetPublicationRequest} request
 * @returns {Promise<void>}
 */
async function publishResetOutcome(request) {
    await stageRetainedRecords(
        request.target,
        request.retainedSource,
        (recordKey) => new ResetPublicationError(recordKey)
    );
    await request.target.batch(await planResetPublication(request));
}

/**
 * @typedef {object} InstallResetRequest
 * @property {RootDatabase} rootDatabase - The opened root database, whose replica
 *   pointer this moves once the publication has succeeded.
 * @property {ReplicaName} targetReplica - The inactive replica the reset is built into.
 * @property {ResetPublicationRequest} publication - The publication itself.
 */

/**
 * Publish a reset outcome and cut the receiver over to it.
 *
 * A rejected publication throws before the pointer moves, which leaves the previously
 * activated replica as the receiver's exposed state.
 *
 * @param {InstallResetRequest} request
 * @returns {Promise<ReplicaName>}
 */
async function installResetOutcome(request) {
    await publishResetOutcome(request.publication);
    await request.rootDatabase.setCurrentReplicaPointer(request.targetReplica);
    return request.targetReplica;
}

module.exports = {
    ResetPublicationError,
    installResetOutcome,
    isResetPublicationError,
    planResetPublication,
    publishResetOutcome,
};
