/**
 * Whether a retained replay state describes the journal it is asked about.
 *
 * The retained state is derived state, and `incremental-graph-journal-storage.md`
 * §Change-bounded proof summary says a derived summary which is missing or stale
 * "requires explicit rebuild/maintenance" and that the operations which consume it
 * must not fall back to scanning retained history to obtain it. A state therefore
 * has to say which journal it was built from, or a caller can hand an operation a
 * state which describes a different journal and the operation will consume it,
 * project from it, and report success over a projection of a journal the receiver
 * does not retain.
 *
 * That correspondence is decided here without visiting a record. The state records,
 * per writer, the greatest coordinate it has admitted, and a `JournalSource` reports,
 * per writer, the length it retains. One `writers()` call and one `retainedLengthOf`
 * call per writer decide the question, which is bounded by the number of writers
 * rather than by the retained history — the same shape
 * `incremental-graph-journal-sync.md` §Phase 2 permits for the coordinates a
 * synchronization resolves its causal coverage against.
 */

/** @typedef {import('../journal/errors').AnyJournalError} JournalError */
/** @typedef {import('../journal/types').JournalAuthor} JournalAuthor */
/** @typedef {import('../journal/types').JournalSequence} JournalSequence */
/** @typedef {import('../journal/oracle/record_source').JournalSource} JournalSource */
/** @typedef {import('./retained').RetainedReplayState} RetainedReplayState */

const {
    compareJournalSequence,
    journalAuthorToString,
    journalSequenceToString,
    makeJournalProjectionError,
} = require("../journal");

/**
 * The reason a retained state does not describe one journal, as a comparison rather
 * than as a message, so a caller can report the writer whose lengths disagree.
 *
 * `undefined` means the state describes the journal.
 *
 * @param {RetainedReplayState} state
 * @param {JournalSource} receiver
 * @returns {{writer: string, admitted: JournalSequence | undefined, retained: JournalSequence | undefined} | undefined}
 */
function retainedStateMismatch(state, receiver) {
    for (const [name, admitted] of state.admittedLengths) {
        const retained = retainedLengthOfName(receiver, name);
        if (retained === undefined) {
            return { writer: name, admitted, retained };
        }
        if (compareJournalSequence(admitted, retained) !== 0) {
            return { writer: name, admitted, retained };
        }
    }
    for (const author of receiver.writers()) {
        const name = journalAuthorToString(author);
        if (!state.admittedLengths.has(name)) {
            return { writer: name, admitted: undefined, retained: receiver.retainedLengthOf(author) };
        }
    }
    return undefined;
}

/**
 * The retained length a source declares for one writer name.
 *
 * `retainedLengthOf` takes the writer itself, so the name is resolved against the
 * writers the source reports rather than against a name parsed here.
 *
 * @param {JournalSource} source
 * @param {string} name
 * @returns {JournalSequence | undefined}
 */
function retainedLengthOfName(source, name) {
    for (const author of source.writers()) {
        if (journalAuthorToString(author) === name) {
            return source.retainedLengthOf(author);
        }
    }
    return undefined;
}

/**
 * Refuse a retained replay state which does not describe the receiver's journal.
 *
 * `incremental-graph-journal-storage.md` §Change-bounded proof summary requires a
 * stale summary to be rebuilt or maintained rather than consumed, and
 * `incremental-graph-journal-sync.md` §Phase 2 requires the state the `P1` cut is
 * derived from to be the receiver's own, so a state which describes a shorter prefix,
 * a longer one, or a different set of writers is refused here and the caller is told
 * which writer's lengths disagree.
 *
 * @param {RetainedReplayState} state - The state the receiver supplied.
 * @param {JournalSource} receiver - The receiver's retained journal.
 * @returns {{error: JournalError} | undefined}
 */
function refuseStaleRetainedState(state, receiver) {
    const mismatch = retainedStateMismatch(state, receiver);
    if (mismatch === undefined) {
        return undefined;
    }
    const admitted = mismatch.admitted === undefined
        ? "no admitted coordinate"
        : journalSequenceToString(mismatch.admitted);
    const retained = mismatch.retained === undefined
        ? "no retained coordinate"
        : journalSequenceToString(mismatch.retained);
    return {
        error: makeJournalProjectionError(
            "the receiver's retained replay state does not describe the receiver's retained " +
                `journal at writer ${mismatch.writer} (admitted ${admitted}, retained ${retained}) ` +
                "and requires explicit rebuild/maintenance",
            ""
        ),
    };
}

module.exports = {
    refuseStaleRetainedState,
};
