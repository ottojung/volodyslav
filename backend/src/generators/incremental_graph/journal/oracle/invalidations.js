/**
 * Invalidation summaries: what a certificate has to have observed.
 *
 * `incremental-graph-journal-replay.md` §Invalidation coverage defines three
 * uncovered predicates over `History(K)`, each "exists an `InvalidateEvent` in
 * `History(K)` which `happenedBefore` the certificate does not observe". Read
 * declaratively those are set existentials over one node's invalidation history.
 *
 * Read as an algorithm they are not. `happenedBefore(I, C)` is a comparison
 * between the coordinate `I` occupies and the frontier `C.context` declares, so
 * "some invalidation of this scope is uncovered by `C`" is exactly "the greatest
 * coordinate any such invalidation occupies is not inside `C.context`". A
 * per-writer maximum therefore answers the question for every certificate at
 * once, and the summary is bounded by the number of writers rather than by the
 * number of invalidations.
 *
 * The scopes stay separate, because the specification's scopes are
 * deliberately different and a merged summary would lose exactly the distinction
 * the three scopes exist to draw:
 *
 * - a node scope has no value member, so its summary is per node;
 * - a value scope names one `ValueId`, so its summary is per node *and* per
 *   current occurrence;
 * - a proof scope names one `ValueId` and one input, so its summary is per node,
 *   per current occurrence, and per direct input.
 *
 * Only the selected occurrence is summarised. The current `ValueId` of a node is
 * known once head selection has run, so the pass which builds these summaries
 * runs after it and discards every invalidation naming a losing occurrence, which
 * the specification says is history with no current meaning.
 */

const { isInvalidateEvent } = require("../records");
const { nodeKeyToCanonicalString } = require("../basis");
const {
    compareJournalSequence,
    journalRecordIdToString,
    journalSequenceAtFrontier,
} = require("../types");
const { raiseCoordinate, streamEveryRecord } = require("./scan");

/** @typedef {import("../errors").AnyJournalError} JournalError */
/** @typedef {import("./record_source").JournalSource} JournalSource */

/**
 * A per-writer maximum of the coordinates some scope occupies.
 *
 * `Map<writerName, JournalSequence>` rather than a `JournalFrontier` because the
 * pass builds it incrementally per record, and a frontier is immutable. The
 * frontier comparison this feeds is exactly `journalSequenceAtFrontier` against
 * an observing context.
 *
 * @typedef {Map<string, import("../types").JournalSequence>} CoordinateMaximum
 */

/**
 * @typedef {object} InvalidationSummary
 * @property {CoordinateMaximum} nodeScoped - Node-scoped invalidations of this
 *   node, at any occurrence.
 * @property {CoordinateMaximum} valueScoped - Value-scoped invalidations naming
 *   this node's selected occurrence.
 * @property {Map<string, CoordinateMaximum>} proofScoped - Proof-scoped
 *   barriers, keyed by the canonical identity of the input whose edge they
 *   retire.
 */

/**
 * @param {unknown} value
 * @returns {value is InvalidationSummary}
 */
function isInvalidationSummary(value) {
    return (
        typeof value === "object" &&
        value !== null &&
        "nodeScoped" in value &&
        "valueScoped" in value &&
        "proofScoped" in value
    );
}

/**
 * @returns {InvalidationSummary}
 */
function makeInvalidationSummary() {
    return { nodeScoped: new Map(), valueScoped: new Map(), proofScoped: new Map() };
}

/**
 * Is every coordinate this summary holds inside `observer`?
 *
 * This is the streaming form of "no invalidation in this scope is uncovered by
 * the certificate". An empty summary covers vacuously, which is the correct
 * answer for a node nobody has invalidated.
 * @param {CoordinateMaximum} summary
 * @param {import("../types").JournalFrontier} observer
 * @param {(name: string) => import("../types").JournalAuthor | undefined} authorOf
 * @returns {boolean}
 */
function summaryIsCovered(summary, observer, authorOf) {
    for (const entry of summary) {
        const author = authorOf(entry[0]);
        if (author === undefined) {
            throw new Error("an invalidation summary names a writer the source does not hold");
        }
        if (compareJournalSequence(journalSequenceAtFrontier(observer, author), entry[1]) < 0) {
            return false;
        }
    }
    return true;
}

/**
 * Build the invalidation summaries which the selected occurrences of `selections`
 * make relevant.
 * @param {JournalSource} source
 * @param {Map<string, {node: import("../types").NodeKey, valueId: import("../types").JournalRecordId}>} selectedOccurrences
 * @returns {{summaries: Map<string, InvalidationSummary>} | {error: JournalError}}
 */
function summarizeInvalidations(source, selectedOccurrences) {
    /** @type {Map<string, InvalidationSummary>} */
    const summaries = new Map();
    /**
     * @param {string} nodeKeyString
     * @returns {InvalidationSummary}
     */
    function summaryFor(nodeKeyString) {
        const existing = summaries.get(nodeKeyString);
        if (existing !== undefined) {
            return existing;
        }
        const created = makeInvalidationSummary();
        summaries.set(nodeKeyString, created);
        return created;
    }
    const failure = streamEveryRecord(source, (record) => {
        if (!isInvalidateEvent(record)) {
            return;
        }
        const nodeKeyString = nodeKeyToCanonicalString(record.node);
        const occurrence = selectedOccurrences.get(nodeKeyString);
        if (occurrence === undefined) {
            return;
        }
        const summary = summaryFor(nodeKeyString);
        if (record.scope.kind === "node") {
            raiseCoordinate(summary.nodeScoped, record);
            return;
        }
        if (journalRecordIdToString(record.scope.value) !== journalRecordIdToString(occurrence.valueId)) {
            return;
        }
        if (record.scope.kind === "value") {
            raiseCoordinate(summary.valueScoped, record);
            return;
        }
        const inputKeyString = nodeKeyToCanonicalString(record.scope.input);
        const existing = summary.proofScoped.get(inputKeyString);
        if (existing === undefined) {
            const created = new Map();
            summary.proofScoped.set(inputKeyString, created);
            raiseCoordinate(created, record);
            return;
        }
        raiseCoordinate(existing, record);
    });
    if (failure !== undefined) {
        return { error: failure };
    }
    return { summaries };
}

module.exports = {
    isInvalidationSummary,
    makeInvalidationSummary,
    summarizeInvalidations,
    summaryIsCovered,
};
