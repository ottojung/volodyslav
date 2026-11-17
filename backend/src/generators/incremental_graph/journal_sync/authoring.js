/**
 * Synchronization-authored Journal records.
 *
 * `incremental-graph-journal-sync.md` §Synchronization-authored allocation
 * defines what a receiver-authored normalization record is: it observes the
 * complete imported/receiver closed frontier, carries the exact own-prefix and
 * transitively closed context, receives authority after the observed semantic
 * high-water, consumes the next receiver writer sequence, and participates in
 * future synchronization normally.
 *
 * `finalizeEmission` in `../journal/emission` allocates exactly that shape, but
 * it is the boundary of an *ordinary* graph transition: it always writes
 * `DeleteEvent(reason="operation")` and `InvalidateEvent(reason="propagated")`.
 * Synchronization's two normalization records carry `reason="sync"`, which is
 * the fact a later reader uses to tell a structural normalization apart from a
 * graph operation, so the reasons cannot be a parameter of the ordinary
 * allocation. This module therefore allocates the same coordinates by the same
 * rules for the sync record kinds only, which is why there are two `make…`
 * functions here and no way to ask for an ordinary reason.
 */

/** @typedef {import('../journal/errors').AnyJournalError} JournalError */
/** @typedef {import('../journal/emission').CommittedWriterState} CommittedWriterState */
/** @typedef {import('../journal/records').JournalRecord} JournalRecord */
/** @typedef {import('../journal/types').AuthorityTime} AuthorityTime */
/** @typedef {import('../journal/types').JournalAuthor} JournalAuthor */
/** @typedef {import('../journal/types').JournalFrontier} JournalFrontier */
/** @typedef {import('../journal/types').JournalRecordId} JournalRecordId */
/** @typedef {import('../journal/types').JournalSequence} JournalSequence */
/** @typedef {import('../database/node_key').NodeKey} NodeKey */

const {
    allocateAuthority,
    contextOf,
    frontierJoin,
    isJournalError,
    makeDeleteEvent,
    makeInvalidateEvent,
    makeJournalFrontier,
    makeJournalPublicationError,
    makeJournalRecordId,
    makeValueScope,
    predecessorJournalSequence,
    requireSuccessorJournalSequence,
} = require("../journal");
/**
 * A synchronization structural removal. The node's selected occurrence cannot
 * remain materialized, and a later recomputation recreates it.
 *
 * @typedef {object} SyncDeleteRequest
 * @property {NodeKey} node
 */

/**
 * A synchronization stale marker. The node's selected occurrence is persistently
 * stale solely through its direct inputs, and the marker is what makes that
 * staleness durable independently of the current selected certificate.
 *
 * @typedef {object} SyncInvalidateRequest
 * @property {NodeKey} node
 * @property {JournalRecordId} value
 */

/**
 * The properties that this class carries are:
 * - `records` is one contiguous own-writer range starting at the committed
 *   `writerHead` successor, whose contexts are the complete observed frontier
 *   with the exact own-writer coordinate, and whose authority is strictly
 *   increasing above the observed high-water; and
 * - `writerState` is the unique committed state after the range.
 *
 * The proof of those properties is guaranteed by:
 * - `finalizeSyncRecords(...)`: it allocates each coordinate as the canonical
 *   successor of the previous one, builds each context from the observed frontier
 *   through `contextOf`, and advances the high-water by `allocateAuthority` before
 *   the next record.
 *
 * @param {ReadonlyArray<JournalRecord>} records
 * @param {CommittedWriterState} writerState
 */
class SyncPublicationClass {
    /**
     * @param {ReadonlyArray<JournalRecord>} records
     * @param {CommittedWriterState} writerState
     */
    constructor(records, writerState) {
        this.records = records;
        this.writerState = writerState;
    }
}

/** @typedef {SyncPublicationClass} SyncPublication */

/**
 * @param {unknown} value
 * @returns {value is SyncPublication}
 */
function isSyncPublication(value) {
    return value instanceof SyncPublicationClass;
}

/**
 * @typedef {object} SyncPublicationRequest
 * @property {CommittedWriterState} committed - The receiver's committed writer state.
 * @property {JournalFrontier} observedFrontier - The complete imported/receiver closed frontier.
 * @property {AuthorityTime} observedHighWater - The greatest authority time the receiver has observed.
 * @property {number} publicationInstant - Epoch milliseconds, the authority seed of every sync record.
 * @property {ReadonlyArray<SyncDeleteRequest>} deletes - Structural removals, ordered cause before dependent.
 * @property {ReadonlyArray<SyncInvalidateRequest>} invalidations - Stale markers.
 */

/**
 * Allocate the one contiguous own-writer range of receiver-authored normalization.
 *
 * Structural removals are allocated before stale markers, so the record order of
 * the range states the two phases in the order the specification defines them.
 *
 * @param {SyncPublicationRequest} request
 * @returns {SyncPublication | {error: JournalError}}
 */
function finalizeSyncRecords(request) {
    const { committed, observedFrontier, observedHighWater, publicationInstant } = request;
    if (!Number.isSafeInteger(publicationInstant) || publicationInstant < 0) {
        return {
            error: makeJournalPublicationError(
                "the synchronization publication instant must be a non-negative whole millisecond"
            ),
        };
    }
    const localWriter = committed.localWriter;

    /** @type {JournalRecord[]} */
    const records = [];
    const firstSequence = requireSuccessorJournalSequence(committed.writerHead);
    if (isJournalError(firstSequence)) {
        return { error: firstSequence };
    }
    /** @type {JournalSequence} */
    let nextSequence = firstSequence;
    let highWater = observedHighWater;

    /**
     * The complete observed frontier, expressed as the writer state `contextOf`
     * reads. The observed frontier is causally closed over every coordinate it
     * claims, which is what makes a context built from it transitively closed.
     * @returns {{state: CommittedWriterState} | {error: JournalError}}
     */
    function observedState() {
        const frontier = makeJournalFrontier([...observedFrontier]);
        if (isJournalError(frontier)) {
            return { error: frontier };
        }
        return {
            state: {
                localWriter,
                writerHead: committed.writerHead,
                committedFrontier: frontier,
                authorityHighWater: observedHighWater,
                allocatorWatermark: committed.allocatorWatermark,
            },
        };
    }

    /**
     * Allocate the next coordinate, context and authority for one record of
     * `node`, and build the event from them.
     * @param {NodeKey} node
     * @param {(base: import('../journal/records').ResolvedEventFields) => JournalRecord | JournalError} build
     * @returns {JournalError | undefined}
     */
    function allocate(node, build) {
        const id = makeJournalRecordId(localWriter, nextSequence);
        if (isJournalError(id)) {
            return id;
        }
        const observed = observedState();
        if ("error" in observed) {
            return observed.error;
        }
        const ownPrefix = predecessorJournalSequence(nextSequence);
        if (isJournalError(ownPrefix)) {
            return ownPrefix;
        }
        const context = contextOf(observed.state, localWriter, ownPrefix);
        if (isJournalError(context)) {
            return context;
        }
        const authority = allocateAuthority(highWater, publicationInstant);
        if ("error" in authority) {
            return authority.error;
        }
        const record = build({ id, context, authorityTime: authority.authorityTime, node });
        if (isJournalError(record)) {
            return record;
        }
        records.push(record);
        highWater = authority.highWater;
        const following = requireSuccessorJournalSequence(nextSequence);
        if (isJournalError(following)) {
            return following;
        }
        nextSequence = following;
        return undefined;
    }

    for (const removal of request.deletes) {
        const failure = allocate(removal.node, (base) => makeDeleteEvent(base, "sync"));
        if (failure !== undefined) {
            return { error: failure };
        }
    }

    for (const invalidation of request.invalidations) {
        const failure = allocate(invalidation.node, (base) =>
            makeInvalidateEvent(base, makeValueScope(invalidation.value), "sync"));
        if (failure !== undefined) {
            return { error: failure };
        }
    }

    if (records.length === 0) {
        const observed = observedState();
        if ("error" in observed) {
            return observed;
        }
        return new SyncPublicationClass([], {
                localWriter,
                writerHead: committed.writerHead,
                committedFrontier: observed.state.committedFrontier,
            authorityHighWater: observedHighWater,
            allocatorWatermark: committed.allocatorWatermark,
        });
    }

    const last = records[records.length - 1];
    if (last === undefined) {
        return { error: makeJournalPublicationError("a synchronization publication authored no record") };
    }
    const advanced = makeJournalFrontier([[localWriter, last.id.sequence]]);
    if (isJournalError(advanced)) {
        return { error: advanced };
    }
    return new SyncPublicationClass(records, {
        localWriter,
        writerHead: last.id.sequence,
        committedFrontier: frontierJoin(observedFrontier, advanced),
        authorityHighWater: highWater,
        allocatorWatermark: committed.allocatorWatermark,
    });
}

module.exports = {
    SyncPublicationClass,
    finalizeSyncRecords,
    isSyncPublication,
};