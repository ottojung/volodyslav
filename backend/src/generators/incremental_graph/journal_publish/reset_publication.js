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
 * rather than replacing it, so the target must hold it as well. The retained records
 * are therefore written alongside the outcome's own records in the same batch, which
 * makes the target sublevel exactly `Jreset` when the batch completes.
 *
 * The target's replica metadata is the receiver's own: version, graph scheme and
 * fingerprint. A reset receiver keeps its own writer identity and authors every record
 * it writes afterwards under that writer, per
 * `incremental-graph-journal-reset.md` §Writer identity, so the target is installed
 * under the receiver's identity rather than adopting the source's.
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
/** @typedef {import('../journal_reset').ResetOutcome} ResetOutcome */

const {
    encodeJournalRecord,
    journalAuthorToString,
} = require('../journal');
const { makeJournalRecordKey } = require('../journal_store');

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
 * The operations which retain the receiver's already committed journal records in the
 * target replica.
 *
 * A record's storage key is its author and coordinate, so writing the receiver's own
 * retained records into the target contributes exactly the keys `Jreset` names for
 * them and nothing else. Occurrence keys are not written here: the shared lowering
 * derives the occurrence index from the projection it lowers, so the target's index
 * names `project(Jreset)` and not the receiver's pre-reset occurrences.
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
            throw new ResetPublicationError(journalAuthorToString(record.id.author));
        }
        operations.push(target.journal.putOp(key, stringToJournalText(encodeJournalRecord(record))));
    }
    return operations;
}

/**
 * @typedef {object} ResetPublicationRequest
 * @property {SchemaStorage} target - The inactive replica the reset is built into.
 * @property {ReadonlyArray<JournalRecord>} retainedRecords - The activated replica's
 *   retained journal, which reset retains rather than replaces.
 * @property {string} receiverVersion - The activated replica's persisted version.
 * @property {string} receiverGraphScheme - The activated replica's persisted graph
 *   scheme.
 * @property {string} receiverFingerprint - The activated replica's own writer identity.
 * @property {ResetOutcome} outcome - What `resetToSource` computed.
 */

/**
 * Build the one operation array which turns the inactive replica into `Jreset`.
 *
 * @param {ResetPublicationRequest} request
 * @returns {Promise<Array<*>>}
 */
async function planResetPublication(request) {
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
 * Publish one reset outcome into the inactive replica.
 *
 * The whole publication is one array of operations and one `batch` call, so the target
 * never exposes a journal which disagrees with its own graph: either `Jreset` and
 * `project(Jreset)` both become visible together or neither does. The caller performs
 * the cutover itself, by moving the replica pointer, and only after this returns.
 *
 * @param {ResetPublicationRequest} request
 * @returns {Promise<void>}
 */
async function publishResetOutcome(request) {
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
