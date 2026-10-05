/**
 * The maintenance traversal which reconstructs the retained replay state.
 *
 * `incremental-graph-journal-storage.md` §Derived indexes permits a missing derived
 * index to be rebuilt only through an explicit rebuild/maintenance transition, and
 * §Change-bounded proof summary says the same of the counted summary. This module is
 * that transition for the whole of the state `retained.js` folds a reset delta
 * into: it traverses the retained journal once and stores what the fold reads, so
 * publication, maintenance and migration can construct or reconstruct it.
 *
 * Reset never calls it. A receiver whose activated replica does not hold the state
 * must be rebuilt or maintained, not silently replayed.
 */

/** @typedef {import('../journal/errors').AnyJournalError} JournalError */
/** @typedef {import('../journal/records').JournalRecord} JournalRecord */
/** @typedef {import('../journal/types').JournalAuthor} JournalAuthor */
/** @typedef {import('../journal/types').JournalSequence} JournalSequence */
/** @typedef {import('../journal/oracle/heads').HeadSelection} HeadSelection */
/** @typedef {import('../journal/oracle/record_source').JournalSource} JournalSource */
/** @typedef {import('./proof_summary').CurrentInputKeysOfNode} CurrentInputKeysOfNode */
/** @typedef {import('./retained').RetainedReplayState} RetainedReplayState */

const {
    isWriterStateRecord,
    journalAuthorToString,
    streamWithReport,
} = require("../journal");
const { buildProofSummary } = require("./proof_summary");

const {
    RetainedReplayStateClass,
    admitRetainedHead,
    projectRetainedReplay,
    raiseAdmittedLength,
} = require("./retained");

/**
 * Build the retained replay state of a retained journal.
 *
 * The properties that this call produces are the ones `retained.js`'s state class
 * documents: a running maximum head candidate per node, the counted proof summary
 * of the same admitted records, every retained writer, and the local writer's
 * allocator watermark, followed by the resolution of the first cut.
 *
 * @param {object} request
 * @param {JournalSource} request.source - The receiver's retained journal.
 * @param {JournalAuthor} request.localWriter
 * @param {CurrentInputKeysOfNode} request.currentInputKeysOfNode
 * @returns {{state: RetainedReplayState} | {error: JournalError}}
 */
function buildRetainedReplayState(request) {
    const { source, localWriter, currentInputKeysOfNode } = request;
    /** @type {Map<string, HeadSelection>} */
    const heads = new Map();
    /** @type {Map<string, JournalAuthor>} */
    const writers = new Map();
    /** @type {Map<string, JournalSequence>} */
    const admittedLengths = new Map();
    const localName = journalAuthorToString(localWriter);
    let lastNodeIndex = 0;
    const failure = streamWithReport(source, (record) => {
        const name = journalAuthorToString(record.id.author);
        writers.set(name, record.id.author);
        raiseAdmittedLength(admittedLengths, name, record.id.sequence);
        if (isWriterStateRecord(record)) {
            if (journalAuthorToString(record.id.author) === localName) {
                lastNodeIndex = record.lastNodeIndex;
            }
            return undefined;
        }
        admitRetainedHead(heads, record);
        return undefined;
    });
    if (failure !== undefined) {
        return { error: failure };
    }
    const proofs = buildProofSummary({
        source,
        occurrences: new Map(),
        currentInputKeysOfNode,
    });
    if ("error" in proofs) {
        return { error: proofs.error };
    }
    const state = new RetainedReplayStateClass(
        heads,
        proofs.summary,
        new Map(),
        new Map(),
        new Set(),
        writers,
        admittedLengths,
        lastNodeIndex,
        localWriter,
        currentInputKeysOfNode
    );
    const projected = projectRetainedReplay(state);
    if ("error" in projected) {
        return projected;
    }
    return { state };
}

module.exports = {
    buildRetainedReplayState,
};