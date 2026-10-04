/**
 * Reset-authored Journal records.
 *
 * `incremental-graph-journal-reset.md` §First retain the observed history makes
 * reset-authored records causally later than the complete observed `J0` frontier,
 * and §Writer identity makes every one of them the receiver's own. `finalizeEmission`
 * in `../journal/emission` allocates that shape for an ordinary graph transition,
 * but an ordinary transition writes `DeleteEvent(reason="operation")` and
 * `InvalidateEvent(reason="propagated")`, and reset's records carry `reason="reset"`.
 * This module therefore allocates the same coordinates by the same rules for the
 * reset record kinds only: the ordinary reasons are not reachable from here, and
 * there is no way to ask for them.
 *
 * The five request kinds are the five records reset authors, in the order the
 * specification gives them: Pass 1 occurrences and target absences, Pass 2 proof
 * barriers and target certificates, Pass 3 freshness markers. The caller decides
 * the order by the order of the requests it passes, because the barrier-before-
 * certificate ordering is a reset rule rather than an allocation rule.
 */

/** @typedef {import('../journal/errors').AnyJournalError} JournalError */
/** @typedef {import('../journal/emission').CommittedWriterState} CommittedWriterState */
/** @typedef {import('../journal/basis').ValidationBasis} ValidationBasis */
/** @typedef {import('../journal/records').JournalRecord} JournalRecord */
/** @typedef {import('../journal/records').ResolvedEventFields} ResolvedEventFields */
/** @typedef {import('../journal/types').AuthorityTime} AuthorityTime */
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
    makeProofScope,
    makeValidateEvent,
    makeValueEvent,
    makeValueScope,
    predecessorJournalSequence,
    requireSuccessorJournalSequence,
} = require("../journal");

/**
 * A reset target occurrence: `PS` does not already have the requested immutable
 * occurrence state selected, so reset authors it.
 *
 * @typedef {object} ResetValueRequest
 * @property {'value'} kind
 * @property {NodeKey} node
 * @property {import('../database/types').NodeIdentifier} nodeIdentifier
 * @property {import('../database/types').ComputedValue} payload
 * @property {string} createdAt
 * @property {string} modifiedAt
 */

/**
 * A reset target absence: the union selects a `ValueEvent` for a node the target
 * does not contain.
 *
 * @typedef {object} ResetDeleteRequest
 * @property {'delete'} kind
 * @property {NodeKey} node
 */

/**
 * A reset proof-edge barrier: one incoming edge of one preserved occurrence which
 * the target must not expose.
 *
 * @typedef {object} ResetProofBarrierRequest
 * @property {'proof-barrier'} kind
 * @property {NodeKey} node
 * @property {JournalRecordId} value
 * @property {NodeKey} input
 */

/**
 * A reset target certificate for one preserved occurrence.
 *
 * @typedef {object} ResetValidationRequest
 * @property {'validate'} kind
 * @property {NodeKey} node
 * @property {JournalRecordId} value
 * @property {ValidationBasis} basis
 */

/**
 * A reset target-persistent-stale marker.
 *
 * @typedef {object} ResetValueMarkerRequest
 * @property {'value-marker'} kind
 * @property {NodeKey} node
 * @property {JournalRecordId} value
 */

/** @typedef {ResetValueRequest | ResetDeleteRequest | ResetProofBarrierRequest | ResetValidationRequest | ResetValueMarkerRequest} ResetRequest */

/**
 * The properties that this class carries are:
 * - `records` is one contiguous own-writer range starting at the committed
 *   `writerHead` successor, in the order of the requests it was given, where every
 *   record's context is the complete observed frontier with the exact own-writer
 *   coordinate and whose authority is strictly increasing above the observed
 *   high-water; and
 * - `writerState` is the unique committed state after that range.
 *
 * The proof of those properties is guaranteed by:
 * - `finalizeResetRecords(...)`: it allocates each coordinate as the canonical
 *   successor of the previous one, builds each context from the observed frontier
 *   through `contextOf`, and advances the high-water by `allocateAuthority` before
 *   the next record.
 *
 * @param {ReadonlyArray<JournalRecord>} records
 * @param {CommittedWriterState} writerState
 */
class ResetPublicationClass {
    /**
     * @param {ReadonlyArray<JournalRecord>} records
     * @param {CommittedWriterState} writerState
     */
    constructor(records, writerState) {
        this.records = records;
        this.writerState = writerState;
    }
}

/** @typedef {ResetPublicationClass} ResetPublication */

/**
 * @param {unknown} value
 * @returns {value is ResetPublication}
 */
function isResetPublication(value) {
    return value instanceof ResetPublicationClass;
}

/**
 * @typedef {object} ResetPublicationRequest
 * @property {CommittedWriterState} committed - The receiver's committed writer state.
 * @property {JournalFrontier} observedFrontier - The complete observed `J0` frontier.
 * @property {AuthorityTime} observedHighWater - The greatest authority time observed.
 * @property {number} publicationInstant - Epoch milliseconds, the authority seed.
 * @property {ReadonlyArray<ResetRequest>} requests
 */

/**
 * Allocate the one contiguous own-writer range of receiver-authored reset records.
 *
 * An empty request list publishes no record and returns the committed state it
 * was given, so a reset which authors nothing does not consume a coordinate.
 *
 * @param {ResetPublicationRequest} request
 * @returns {ResetPublication | {error: JournalError}}
 */
function finalizeResetRecords(request) {
    const { committed, observedFrontier, observedHighWater, publicationInstant } = request;
    if (!Number.isSafeInteger(publicationInstant) || publicationInstant < 0) {
        return {
            error: makeJournalPublicationError(
                "the reset publication instant must be a non-negative whole millisecond"
            ),
        };
    }
    const localWriter = committed.localWriter;

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
     * Allocate the next coordinate, context and authority for one request, and
     * build the record from them.
     * @param {ResetRequest} entry
     * @returns {JournalError | undefined}
     */
    function allocate(entry) {
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
        /** @type {ResolvedEventFields} */
        const base = { id, context, authorityTime: authority.authorityTime, node: entry.node };
        /** @type {JournalRecord | JournalError} */
        let record;
        if (entry.kind === "value") {
            record = makeValueEvent(
                base,
                entry.nodeIdentifier,
                entry.payload,
                entry.createdAt,
                entry.modifiedAt,
                "reset"
            );
        } else if (entry.kind === "delete") {
            record = makeDeleteEvent(base, "reset");
        } else if (entry.kind === "proof-barrier") {
            record = makeInvalidateEvent(base, makeProofScope(entry.value, entry.input), "reset");
        } else if (entry.kind === "validate") {
            record = makeValidateEvent(base, entry.value, entry.basis, "reset");
        } else {
            record = makeInvalidateEvent(base, makeValueScope(entry.value), "reset");
        }
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

    for (const entry of request.requests) {
        const failure = allocate(entry);
        if (failure !== undefined) {
            return { error: failure };
        }
    }

    if (records.length === 0) {
        const observed = observedState();
        if ("error" in observed) {
            return observed;
        }
        return new ResetPublicationClass([], {
            localWriter,
            writerHead: committed.writerHead,
            committedFrontier: observed.state.committedFrontier,
            authorityHighWater: observedHighWater,
            allocatorWatermark: committed.allocatorWatermark,
        });
    }

    const last = records[records.length - 1];
    if (last === undefined) {
        return { error: makeJournalPublicationError("a reset publication authored no record") };
    }
    const advanced = makeJournalFrontier([[localWriter, last.id.sequence]]);
    if (isJournalError(advanced)) {
        return { error: advanced };
    }
    return new ResetPublicationClass(records, {
        localWriter,
        writerHead: last.id.sequence,
        committedFrontier: frontierJoin(observedFrontier, advanced),
        authorityHighWater: highWater,
        allocatorWatermark: committed.allocatorWatermark,
    });
}

module.exports = {
    ResetPublicationClass,
    finalizeResetRecords,
    isResetPublication,
};