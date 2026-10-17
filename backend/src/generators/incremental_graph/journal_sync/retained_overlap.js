/**
 * Same-ID evidence at the retained seam of a foreign-writer import.
 *
 * `incremental-graph-journal-sync.md` §Immutable overlap law makes shared-prefix
 * identity a supported-lifecycle theorem rather than an O(history) check: the
 * acquisition reads the source's missing suffix and never the coordinates the
 * receiver already retains, so the overlap is not rescanned to re-prove the
 * theorem. The same section requires the opposite treatment when same-ID
 * disagreement *is* encountered: the operation rejects that evidence as
 * `JournalForkError` instead of repairing it with payload equality, authority,
 * source preference, Git ancestry or record-ID remapping.
 *
 * This module is where the two meet. It reads the source's own opening records and
 * compares exactly those which the receiver also retains, by canonical
 * current-format meaning, reporting a disagreement as `JournalForkError`. A source
 * which opens above the receiver's retained length presents no same-ID evidence,
 * and then nothing is read here at all: the opening record is handed back to the
 * acquisition rather than re-read, and the receiver's stream is never opened. A
 * source which offers retained coordinates has produced evidence, and only the
 * coordinates it offers are compared, so the comparison stays within the evidence
 * the source itself supplied.
 */

/** @typedef {import('../journal/errors').AnyJournalError} JournalError */
/** @typedef {import('../journal/records').JournalRecord} JournalRecord */
/** @typedef {import('../journal/types').JournalSequence} JournalSequence */
/** @typedef {import('../journal/oracle/record_source').PrefixReader} PrefixReader */

/**
 * @typedef {object} RetainedOverlap
 * @property {JournalRecord | undefined} pending - The source's first record above
 *   the receiver's retained length, which the acquisition continues from, or
 *   `undefined` when the source holds no record above it.
 */

/**
 * @typedef {object} RetainedOverlapFailure
 * @property {JournalError} error
 */

const {
    compareJournalSequence,
    encodeJournalRecord,
    journalRecordIdToString,
    journalSequenceToString,
    makeJournalForkError,
    makeJournalGapError,
} = require("../journal");

/**
 * Compare one source record at a coordinate the receiver also retains against the
 * receiver's own record at that coordinate.
 *
 * The two records must occupy the same coordinate, and they must have identical
 * canonical current-format meaning. A coordinate the receiver does not retain is
 * the receiver's retained stream disagreeing with its own declared length, which
 * is reported as a gap rather than reconciled.
 *
 * @param {JournalRecord} offered - The source's record at the coordinate.
 * @param {PrefixReader} retained - A reader over the receiver's own stream.
 * @param {string} authorName
 * @param {JournalSequence} retainedLength - The receiver's retained length.
 * @returns {JournalError | undefined}
 */
function validateRetainedOverlapAgreement(offered, retained, authorName, retainedLength) {
    const failure = retained.failure();
    if (failure !== undefined) {
        return failure;
    }
    const own = retained.nextRecord();
    if (own === undefined) {
        return makeJournalGapError(
            authorName,
            journalSequenceToString(retainedLength),
            journalSequenceToString(offered.id.sequence)
        );
    }
    if (compareJournalSequence(own.id.sequence, offered.id.sequence) !== 0) {
        return makeJournalGapError(
            authorName,
            journalSequenceToString(offered.id.sequence),
            journalSequenceToString(own.id.sequence)
        );
    }
    const ownMeaning = encodeJournalRecord(own);
    const offeredMeaning = encodeJournalRecord(offered);
    if (ownMeaning === offeredMeaning) {
        return undefined;
    }
    return makeJournalForkError(
        journalRecordIdToString(offered.id),
        ownMeaning,
        offeredMeaning
    );
}

/**
 * Read the source's records at or below the receiver's retained length and compare
 * each with the receiver's own record at that coordinate.
 *
 * @param {PrefixReader} reader - A reader over the source's stream.
 * @param {PrefixReader} retained - A reader over the receiver's own stream.
 * @param {string} authorName
 * @param {JournalSequence} retainedLength - The receiver's retained length.
 * @returns {RetainedOverlap | RetainedOverlapFailure}
 */
function readRetainedOverlap(reader, retained, authorName, retainedLength) {
    for (;;) {
        const record = reader.nextRecord();
        if (record === undefined) {
            const failure = reader.failure();
            if (failure !== undefined) {
                return { error: failure };
            }
            return { pending: undefined };
        }
        if (compareJournalSequence(record.id.sequence, retainedLength) > 0) {
            return { pending: record };
        }
        const agreement = validateRetainedOverlapAgreement(
            record,
            retained,
            authorName,
            retainedLength
        );
        if (agreement !== undefined) {
            return { error: agreement };
        }
    }
}

module.exports = {
    readRetainedOverlap,
    validateRetainedOverlapAgreement,
};
