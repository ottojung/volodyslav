/**
 * Reconciling a replica's retained own-writer length against its committed writer head.
 *
 * A replica publishes its committed-pair metadata in the same atomic write as the
 * records it names, so its retained length for its own local writer is exactly the
 * committed `writerHead`. A retained length below that head is evidence that an
 * existing local writer has lost a surviving suffix, which
 * `incremental-graph-journal-testing.md` §Corruption tests lists among the defects a
 * boundary which newly admits state must reject. The lifecycle fault model has no
 * supported partial rollback, so the condition fails closed rather than being
 * repaired.
 *
 * The read is one `retainedLengthOf` call for the local writer, so the check is
 * constant-size and visits no record. It belongs to the persistence front because it
 * is the one place where a replica's committed metadata and its retained journal are
 * both in hand.
 */

/** @typedef {import('../journal/errors').AnyJournalError} JournalError */
/** @typedef {import('../journal/emission').CommittedWriterState} CommittedWriterState */
/** @typedef {import('../journal/oracle/record_source').JournalSource} JournalSource */

const {
    compareJournalSequence,
    journalAuthorToString,
    journalSequenceToString,
    makeJournalWriterBehindError,
    ZERO_JOURNAL_SEQUENCE,
} = require('../journal');

/**
 * Refuse a source whose retained own-writer length is behind its committed writer head.
 *
 * @param {JournalSource} source - The replica's retained journal, read under its own
 *   committed metadata.
 * @param {CommittedWriterState} committed - The replica's committed-pair metadata.
 * @returns {JournalError | undefined}
 */
function reconcileRetainedWriterHead(source, committed) {
    const retained = source.retainedLengthOf(committed.localWriter);
    const retainedSequence = retained === undefined ? ZERO_JOURNAL_SEQUENCE : retained;
    if (compareJournalSequence(committed.writerHead, retainedSequence) <= 0) {
        return undefined;
    }
    return makeJournalWriterBehindError(
        journalAuthorToString(committed.localWriter),
        journalSequenceToString(retainedSequence),
        journalSequenceToString(committed.writerHead)
    );
}

module.exports = {
    reconcileRetainedWriterHead,
};
