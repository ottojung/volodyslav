/**
 * The streaming record source the oracle reads.
 *
 * The oracle never receives a `JournalReplica`. It receives a `JournalSource`,
 * which exposes one writer's retained prefix at a time as a pull reader, plus
 * that writer's retained length. That is the shape a per-writer range iterator
 * over the Journal sublevel has, so a future persistence front can supply the
 * oracle without changing it.
 *
 * A source may be a prefix *union* of several retained prefixes, and the union
 * is performed by a streaming merge. The two structural journal properties fall
 * out of that merge rather than being checked by a separate pass over history:
 *
 * - **no holes.** Every reader holds the coordinate it expects next and admits
 *   only the record at exactly that coordinate, bounded by the retained length
 *   the source declares. A prefix which skips a coordinate fails at that
 *   coordinate, because the counter is the only thing which admits a record. A
 *   separate contiguity scan would be a second traversal of the same records to
 *   learn something the reader already knows while producing them.
 * - **no forks.** Two contributors which both supply one coordinate are compared
 *   by canonical current-format meaning at the moment the merge admits that
 *   coordinate, so disagreement is reported without rescanning the historical
 *   overlap.
 *
 * Neither property is asserted by the oracle. Each is a consequence of the
 * reader, and a fixture which violates either one fails inside the reader.
 */

const {
    makeJournalGapError,
    makeJournalRecordValidationError,
} = require("../errors");
const { isJournalRecord } = require("../records");
const {
    compareJournalSequence,
    journalAuthorToString,
    journalRecordIdToString,
    journalSequenceToString,
    makeJournalSequence,
    ZERO_JOURNAL_SEQUENCE,
} = require("../types");

/** @typedef {import("../errors").AnyJournalError} JournalError */
/** @typedef {import("../records").JournalRecord} JournalRecord */
/** @typedef {import("../types").JournalAuthor} JournalAuthor */
/** @typedef {import("../types").JournalSequence} JournalSequence */

/**
 * A canonical sequence coordinate, or a thrown defect in this module's own
 * literals.
 *
 * The record layer's `makeJournalSequence` reports a malformed coordinate as an
 * error value, which is right at a record boundary and wrong here: every digit
 * string this module passes is a literal or a decimal successor it computed
 * itself, so a rejection is a bug in the oracle rather than bad input.
 * @param {string} digits
 * @returns {JournalSequence}
 */
function canonicalSequence(digits) {
    const sequence = makeJournalSequence(digits);
    if (sequence instanceof Error) {
        throw new Error("the oracle built a coordinate the canonical pattern rejects: " + digits);
    }
    return sequence;
}

/**
 * A pull reader over one writer's retained records in writer-stream order.
 *
 * Reading is destructive: `nextRecord` advances. Every pass the oracle makes
 * therefore asks the source for a fresh reader rather than keeping one.
 *
 * `nextRecord` is asynchronous because a durable source reads a LevelDB range one
 * entry at a time and every such read is a promise. The oracle's passes await each
 * record, so a source is consumed incrementally and no writer's history is
 * materialised as one collection.
 *
 * @typedef {object} PrefixReader
 * @property {() => Promise<JournalRecord | undefined>} nextRecord - The next
 *   retained record, or `undefined` at the end of the retained prefix.
 * @property {() => JournalError | undefined} failure - The structural failure
 *   which ended the prefix, or `undefined` while the prefix is intact. A
 *   non-`undefined` failure means the reader delivered a partial prefix, and the
 *   consumer must not treat it as a whole one.
 */

/**
 * A re-readable source of retained journal records, one writer prefix at a time.
 *
 * Every method is per writer. There is deliberately no method which returns the
 * complete retained journal, every writer's history at once, or one node's
 * history as a collection, so a caller cannot reintroduce whole-journal
 * materialisation through this interface.
 *
 * @typedef {object} JournalSource
 * @property {() => ReadonlyArray<JournalAuthor>} writers - The writers with a
 *   retained prefix, in ascending author order. The order is part of the
 *   contract because callers enumerate the source: a source which returned its
 *   writers in an arbitrary order would make a caller's own decisions
 *   order-dependent. The oracle's own passes do not rely on it — each one sorts
 *   before walking, so the defect the oracle reports is the same for every
 *   enumeration order a source can produce — but a source author should still
 *   return them sorted, because `makeUnionSource` and a caller's per-writer
 *   aggregation do read this order directly.
 * @property {(author: JournalAuthor) => JournalSequence | undefined} retainedLengthOf -
 *   The greatest retained coordinate of one writer, or `undefined` when the
 *   writer is absent. A writer's length is one constant-size read, not a scan.
 * @property {(author: JournalAuthor) => PrefixReader} prefixReaderOf - A fresh
 *   reader over one writer's retained records in writer-stream order. Each call
 *   is an independent traversal, because the oracle makes several passes.
 */

/**
 * The canonical decimal successor of a coordinate.
 *
 * The oracle walks `A:1 .. A:q`, and a sequence coordinate is arbitrary
 * precision, so the successor is decimal string arithmetic on canonical digits.
 * It is deliberately not a `number` and not a `BigInt`: a `number` would lose
 * precision above 2^53, and `BigInt` is not available at this module's
 * compilation target.
 * @param {JournalSequence} sequence
 * @returns {JournalSequence}
 */
function successorJournalSequence(sequence) {
    const digits = journalSequenceToString(sequence).split("");
    let index = digits.length - 1;
    while (index >= 0) {
        const nextDigit = Number(digits[index]) + 1;
        digits[index] = String(nextDigit % 10);
        if (nextDigit < 10) {
            break;
        }
        index--;
    }
    const incremented = index < 0 ? "1" + digits.join("") : digits.join("");
    return canonicalSequence(incremented);
}

/**
 * @param {JournalRecord} record
 * @param {string} authorName
 * @returns {JournalError | undefined}
 */
function validateContributorRecord(record, authorName) {
    if (!isJournalRecord(record)) {
        return makeJournalRecordValidationError(
            "a retained prefix contains a value which is not a current-format record",
            authorName
        );
    }
    if (journalAuthorToString(record.id.author) !== authorName) {
        return makeJournalRecordValidationError(
            "a retained prefix contains a record filed under another writer",
            journalRecordIdToString(record.id)
        );
    }
    return undefined;
}

/**
 * The no-holes and no-overrun decision one retained prefix is admitted through.
 *
 * The declared retained length bounds the walk in both directions, so a prefix
 * which skips a coordinate, a prefix which ends before the length it claims, and
 * a prefix which offers a coordinate beyond the length it claims are all failures
 * rather than being silently accepted as a whole prefix. The last case matters
 * because the source's declared length is what every retained-range check in
 * replay is measured against: a reader which delivered a coordinate past it
 * would hand replay a record whose own coordinate contradicts the frontier the
 * source published for that writer.
 *
 * The decision is shared by every reader constructor so that an in-memory supply
 * and a durable range iterator decide the same prefix by the same rule. A reader
 * feeds one record at a time into `accept`, reports a storage-layer failure
 * through `fail`, and reports the end of the supply through `end`.
 *
 * @param {string} authorName
 * @param {JournalSequence} claimedLength
 * @param {JournalSequence | undefined} startSequence - The first coordinate this
 *   reader offers, for a prefix which begins part-way through a writer's stream.
 *   It defaults to the canonical first coordinate, so a whole retained prefix is
 *   read as before. A reader over a suffix admits nothing before this
 *   coordinate, which is what lets a receiver's own retained prefix and an
 *   imported suffix of the same writer be unioned into one contiguous stream.
 * @returns {{accept: (record: JournalRecord) => JournalRecord | undefined, end: () => void, fail: (error: JournalError) => void, failure: () => JournalError | undefined}}
 */
function makeAdmissionState(authorName, claimedLength, startSequence) {
    let expected = startSequence === undefined ? canonicalSequence("1") : startSequence;
    let lastRead = ZERO_JOURNAL_SEQUENCE;
    /** @type {JournalError | undefined} */
    let failure;

    /**
     * @param {string} missingSequence
     * @returns {JournalError}
     */
    function gapAt(missingSequence) {
        return makeJournalGapError(
            authorName,
            journalSequenceToString(claimedLength),
            missingSequence
        );
    }

    return {
        /**
         * @param {JournalRecord} record
         * @returns {JournalRecord | undefined}
         */
        accept(record) {
            if (failure !== undefined) {
                return undefined;
            }
            const invalid = validateContributorRecord(record, authorName);
            if (invalid !== undefined) {
                failure = invalid;
                return undefined;
            }
            const position = compareJournalSequence(record.id.sequence, expected);
            if (position < 0) {
                failure = makeJournalRecordValidationError(
                    "a retained prefix is not in strictly increasing writer-stream order",
                    journalRecordIdToString(record.id)
                );
                return undefined;
            }
            if (position > 0) {
                failure = gapAt(journalSequenceToString(expected));
                return undefined;
            }
            if (compareJournalSequence(expected, claimedLength) > 0) {
                failure = makeJournalRecordValidationError(
                    "a retained prefix offers " +
                        journalRecordIdToString(record.id) +
                        ", which is beyond the retained length " +
                        journalSequenceToString(claimedLength) +
                        " the source declared",
                    journalRecordIdToString(record.id)
                );
                return undefined;
            }
            lastRead = expected;
            expected = successorJournalSequence(expected);
            return record;
        },
        /**
         * The supply ended; a prefix which stopped before its declared length is a
         * hole at the coordinate it failed to reach.
         * @returns {void}
         */
        end() {
            if (failure === undefined && compareJournalSequence(lastRead, claimedLength) < 0) {
                failure = gapAt(journalSequenceToString(expected));
            }
        },
        /**
         * @param {JournalError} error
         * @returns {void}
         */
        fail(error) {
            failure = error;
        },
        failure: () => failure,
    };
}

/**
 * A reader over a supply of records pulled one at a time.
 *
 * The supply reports a record, `undefined` at its end, or a `JournalError` when
 * the storage layer could not produce the next record. The reader is an
 * error-as-value boundary: a supply failure is delivered through `failure`
 * rather than thrown past the reader, exactly as a structural prefix failure is.
 *
 * @param {string} authorName
 * @param {() => Promise<JournalRecord | JournalError | undefined>} next
 * @param {JournalSequence} claimedLength
 * @param {JournalSequence} [startSequence]
 * @returns {PrefixReader}
 */
function readerOverRecordSupply(authorName, next, claimedLength, startSequence) {
    const state = makeAdmissionState(authorName, claimedLength, startSequence);
    return {
        async nextRecord() {
            if (state.failure() !== undefined) {
                return undefined;
            }
            const value = await next();
            if (value === undefined) {
                state.end();
                return undefined;
            }
            if (value instanceof Error) {
                state.fail(value);
                return undefined;
            }
            return state.accept(value);
        },
        failure: () => state.failure(),
    };
}

/**
 * A reader over one writer's retained records which decides the no-holes
 * condition as it goes.
 *
 * The supply is an in-memory iterable; a durable source supplies records through
 * `readerOverRecordSupply` directly, so this function never sees an async
 * iterable and does not need to distinguish one.
 * @param {string} authorName
 * @param {Iterable<JournalRecord>} iterable
 * @param {JournalSequence} claimedLength
 * @param {JournalSequence} [startSequence]
 * @returns {PrefixReader}
 */
function readerOverIterable(authorName, iterable, claimedLength, startSequence) {
    const iterator = iterable[Symbol.iterator]();
    return readerOverRecordSupply(authorName, async () => {
        const step = iterator.next();
        return step.done === true ? undefined : step.value;
    }, claimedLength, startSequence);
}


module.exports = {
    canonicalSequence,
    readerOverIterable,
    readerOverRecordSupply,
    successorJournalSequence,
    validateContributorRecord,
};
