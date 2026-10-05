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
 * A journal is described by its writers and by the local writer it is written under,
 * so the correspondence has two axes and both are decided here. The per-writer
 * admitted lengths are compared against the lengths the receiver retains in both
 * directions, and the state's local writer is compared against the receiver's
 * established one: `incremental-graph-journal-replay.md` §Host-local allocation
 * watermark derives `last_node_index` from the writer-state records of the local
 * writer alone and says a foreign writer-state record does not change this database's
 * local watermark, so a state built for another local writer carries no watermark of
 * this receiver's even when its admitted lengths agree exactly. `sync.md`
 * §Atomic publication publishes the local writer's allocator/high-water state
 * together with the journal it belongs to, so publishing another writer's watermark
 * under this receiver's own is not a supported outcome and the state is refused.
 *
 * None of this visits a record. The admitted lengths cost one `writers()` call for the
 * receiver's own writer set plus one `writers()` call and one `retainedLengthOf` call
 * per admitted writer, and the local writer costs one author comparison, so the whole
 * decision is bounded by the number of writers rather than by the retained history —
 * the same shape `incremental-graph-journal-sync.md` §Phase 2 permits for the
 * coordinates a synchronization resolves its causal coverage against.
 */

/** @typedef {import('../journal/errors').AnyJournalError} JournalError */
/** @typedef {import('../journal/types').JournalAuthor} JournalAuthor */
/** @typedef {import('../journal/types').JournalSequence} JournalSequence */
/** @typedef {import('../journal/oracle/record_source').JournalSource} JournalSource */
/** @typedef {import('./retained').RetainedReplayState} RetainedReplayState */

const {
    compareJournalSequence,
    isSameJournalAuthor,
    journalAuthorToString,
    journalSequenceToString,
    makeJournalProjectionError,
} = require("../journal");

/**
 * @typedef {object} LocalWriterDivergence
 * @property {'localWriter'} axis - The axis the state and the receiver disagree on.
 * @property {string} stateWriter - The local writer the state was built for.
 * @property {string} receiverWriter - The receiver's own established local writer.
 */

/**
 * @typedef {object} LengthDivergence
 * @property {'lengths'} axis - The axis the state and the receiver disagree on.
 * @property {string} writer - The writer whose lengths disagree.
 * @property {JournalSequence | undefined} admitted - The greatest coordinate the
 *   state admits, or `undefined` when the state admits none.
 * @property {JournalSequence | undefined} retained - The greatest coordinate the
 *   receiver retains, or `undefined` when it retains none.
 */

/**
 * The reason a retained state does not describe one journal, as a comparison rather
 * than as a message, so a caller can report the axis on which the two disagree.
 *
 * `undefined` means the state describes the journal.
 *
 * @param {RetainedReplayState} state
 * @param {JournalSource} receiver
 * @param {JournalAuthor} localWriter - The receiver's own established local writer.
 * @returns {LocalWriterDivergence | LengthDivergence | undefined}
 */
function retainedStateDivergence(state, receiver, localWriter) {
    if (!isSameJournalAuthor(state.localWriter, localWriter)) {
        return {
            axis: "localWriter",
            stateWriter: journalAuthorToString(state.localWriter),
            receiverWriter: journalAuthorToString(localWriter),
        };
    }
    for (const [name, admitted] of state.admittedLengths) {
        const retained = retainedLengthOfName(receiver, name);
        if (retained === undefined) {
            return { axis: "lengths", writer: name, admitted, retained };
        }
        if (compareJournalSequence(admitted, retained) !== 0) {
            return { axis: "lengths", writer: name, admitted, retained };
        }
    }
    for (const author of receiver.writers()) {
        const name = journalAuthorToString(author);
        if (!state.admittedLengths.has(name)) {
            return {
                axis: "lengths",
                writer: name,
                admitted: undefined,
                retained: receiver.retainedLengthOf(author),
            };
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
 * The refusal a divergence is reported as.
 *
 * @param {LocalWriterDivergence | LengthDivergence} divergence
 * @returns {{error: JournalError}}
 */
function refuseDivergence(divergence) {
    if (divergence.axis === "localWriter") {
        return {
            error: makeJournalProjectionError(
                "the receiver's retained replay state does not describe the receiver's retained " +
                    `journal because it was built for local writer ${divergence.stateWriter} rather ` +
                    `than for local writer ${divergence.receiverWriter} (whose allocator watermark ` +
                    "it therefore does not carry) and requires explicit rebuild/maintenance",
                ""
            ),
        };
    }
    const admitted = divergence.admitted === undefined
        ? "no admitted coordinate"
        : journalSequenceToString(divergence.admitted);
    const retained = divergence.retained === undefined
        ? "no retained coordinate"
        : journalSequenceToString(divergence.retained);
    return {
        error: makeJournalProjectionError(
            "the receiver's retained replay state does not describe the receiver's retained " +
                `journal at writer ${divergence.writer} (admitted ${admitted}, retained ${retained}) ` +
                "and requires explicit rebuild/maintenance",
            ""
        ),
    };
}

/**
 * Refuse a retained replay state which does not describe the receiver's journal.
 *
 * `incremental-graph-journal-storage.md` §Change-bounded proof summary requires a
 * stale summary to be rebuilt or maintained rather than consumed, and
 * `incremental-graph-journal-sync.md` §Phase 2 requires the state the `P1` cut is
 * derived from to be the receiver's own, so a state which was built for another local
 * writer, or which describes a shorter prefix, a longer one, or a different set of
 * writers, is refused here and the caller is told which axis disagrees.
 *
 * @param {RetainedReplayState} state - The state the receiver supplied.
 * @param {JournalSource} receiver - The receiver's retained journal.
 * @param {JournalAuthor} localWriter - The receiver's own established local writer.
 * @returns {{error: JournalError} | undefined}
 */
function refuseStaleRetainedState(state, receiver, localWriter) {
    const divergence = retainedStateDivergence(state, receiver, localWriter);
    if (divergence === undefined) {
        return undefined;
    }
    return refuseDivergence(divergence);
}

module.exports = {
    refuseStaleRetainedState,
};