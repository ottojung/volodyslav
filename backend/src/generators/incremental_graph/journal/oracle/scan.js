/**
 * The streaming pass driver and the context conditions replay relies on.
 *
 * Every pass the oracle makes walks one writer prefix at a time and folds each
 * record into graph-sized derived state. Nothing in this module builds a set of
 * one node's records, a set of all records, or a set of all eligible
 * certificates: a pass decides each record as it arrives and forgets it.
 *
 * Two conditions are checked here as each context is used, rather than in a
 * separate history pass, because both are decidable from one record and from the
 * source's retained lengths alone:
 *
 * - **every claimed coordinate is retained.** The merge's counter gives each
 *   writer's retained length, so a context which claims a coordinate beyond it
 *   is detected at the point replay would have relied on that coordinate.
 * - **own-writer prefix exactness.** A record's own-writer context coordinate is
 *   exactly its predecessor, so a record never claims to have observed a same
 *   writer coordinate it has not allocated.
 *
 * Transitive closure of a context is a premise here, not a consequence. Replay
 * decides causality *only* from the frontier a context declares, so the oracle's
 * answers are exactly the answers a closed cut would give; the oracle re-derives
 * what a closed cut implies and consumes closure itself, which
 * `../context_closure` states. A fixture whose context is deliberately not
 * closed therefore changes the oracle's output rather than being rejected by it,
 * and that difference is the executable statement of the choice.
 */

const { makeJournalCausalClosureError } = require("../errors");
const {
    compareJournalSequence,
    journalAuthorToString,
    journalRecordIdToString,
    journalSequenceAtFrontier,
    journalSequenceToString,
    predecessorJournalSequence,
} = require("../types");

/** @typedef {import("../errors").AnyJournalError} JournalError */
/** @typedef {import("../records").JournalRecord} JournalRecord */
/** @typedef {import("../types").JournalAuthor} JournalAuthor */
/** @typedef {import("../types").JournalFrontier} JournalFrontier */
/** @typedef {import("./record_source").JournalSource} JournalSource */

/**
 * The retained lengths a context claim is checked against. The source itself
 * satisfies this shape.
 * @typedef {object} RetainedLengths
 * @property {(author: JournalAuthor) => import("../types").JournalSequence | undefined} retainedLengthOf
 */

/**
 * Is the record's own-writer context coordinate exactly its predecessor, and is
 * every coordinate it claims actually retained?
 *
 * These are the two context conditions decidable from one record and the source's
 * retained lengths. A context which passes both is well formed as a claim;
 * whether the claim is transitively closed is the premise replay reads.
 * @param {import("../records").SemanticEvent} event
 * @param {RetainedLengths} retained
 * @returns {JournalError | undefined}
 */
function validateContextClaim(event, retained) {
    const label = journalRecordIdToString(event.id);
    const own = journalSequenceAtFrontier(event.context, event.id.author);
    const predecessor = predecessorJournalSequence(event.id.sequence);
    if (predecessor instanceof Error) {
        return makeJournalCausalClosureError(
            label,
            "complete local prefix",
            "this record has no complete local prefix"
        );
    }
    if (compareJournalSequence(own, predecessor) !== 0) {
        return makeJournalCausalClosureError(
            label,
            "complete local prefix",
            "own-writer context is " +
                journalSequenceToString(own) +
                " but must be exactly " +
                journalSequenceToString(predecessor)
        );
    }
    for (const coordinate of event.context) {
        const length = retained.retainedLengthOf(coordinate[0]);
        if (length === undefined) {
            return makeJournalCausalClosureError(
                label,
                "retained-range coverage",
                "context claims writer " +
                    journalAuthorToString(coordinate[0]) +
                    ", which retains nothing"
            );
        }
        if (compareJournalSequence(coordinate[1], length) > 0) {
            return makeJournalCausalClosureError(
                label,
                "retained-range coverage",
                "context claims " +
                    journalAuthorToString(coordinate[0]) +
                    ":" +
                    journalSequenceToString(coordinate[1]) +
                    ", which is not retained"
            );
        }
    }
    return undefined;
}

/**
 * Raise one record's own coordinate into a per-writer maximum.
 * @param {Map<string, import("../types").JournalSequence>} summaries
 * @param {import("../records").SemanticEvent} event
 * @returns {void}
 */
function raiseCoordinate(summaries, event) {
    const name = journalAuthorToString(event.id.author);
    const current = summaries.get(name);
    if (current === undefined || compareJournalSequence(event.id.sequence, current) > 0) {
        summaries.set(name, event.id.sequence);
    }
}

/**
 * Stream every retained record once, folding each into `visit`.
 * @param {JournalSource} source
 * @param {(record: JournalRecord) => void} visit
 * @returns {JournalError | undefined}
 */
function streamEveryRecord(source, visit) {
    return streamWithReport(source, (record) => {
        visit(record);
        return undefined;
    });
}

/**
 * Stream every retained record once, stopping at the first failure `visit`
 * reports as well as at the first structural failure.
 *
 * A pass which cannot trust its derived state must not keep folding into it, so
 * the walk ends where the visitor reports a failure.
 * @param {JournalSource} source
 * @param {(record: JournalRecord) => JournalError | undefined} visit
 * @returns {JournalError | undefined}
 */
function streamWithReport(source, visit) {
    for (const author of source.writers()) {
        const reader = source.prefixReaderOf(author);
        for (;;) {
            const record = reader.nextRecord();
            if (record === undefined) {
                break;
            }
            const reported = visit(record);
            if (reported !== undefined) {
                return reported;
            }
        }
        const mergeFailure = reader.failure();
        if (mergeFailure !== undefined) {
            return mergeFailure;
        }
    }
    return undefined;
}

module.exports = {
    raiseCoordinate,
    streamEveryRecord,
    streamWithReport,
    validateContextClaim,
};
