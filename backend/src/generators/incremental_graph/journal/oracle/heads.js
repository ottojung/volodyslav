/**
 * Semantic head selection: which occurrence each node currently has.
 *
 * `incremental-graph-journal-replay.md` §Semantic value/absence head defines
 * `HeadCandidates(K) = ValueEvents(K) union DeleteEvents(K)` and
 * `head(K) = greatest HeadCandidate by authorityCompare`. Declaratively that is
 * a set per node; as an algorithm it is a running maximum, because `head` is
 * order-independent under `authorityCompare`. The oracle therefore keeps one
 * candidate per node and decides each record as it streams past.
 *
 * A losing `ValueEvent` stays history but supplies no current payload, however
 * deeply equal that payload is, so the fold never compares payloads and never
 * needs to look at a losing candidate again.
 */

const { isDeleteEvent, isValueEvent } = require("../records");
const { authorityCompare } = require("../ordering");
const { nodeKeyToCanonicalString } = require("../basis");
const { streamEveryRecord } = require("./scan");

/** @typedef {import("../errors").AnyJournalError} JournalError */
/** @typedef {import("../records").JournalRecord} JournalRecord */
/** @typedef {import("../records").ValueEvent} ValueEvent */
/** @typedef {import("./record_source").JournalSource} JournalSource */

/**
 * The properties that this class carries are:
 * - `winner` is the greatest `ValueEvent` or `DeleteEvent` of one semantic node
 *   under `authorityCompare`, and is `undefined` exactly when the journal holds
 *   no head candidate for that node.
 * - `nodeKeyString` is the canonical persisted identity of `winner.node`, and is
 *   `undefined` exactly when `winner` is.
 *
 * The proof of those properties is guaranteed by:
 * - `selectSemanticHeads(source)`: visits every retained record, and replaces
 *   the stored winner exactly when the arriving candidate is greater under
 *   `authorityCompare`, so after the final record the stored candidate is the
 *   maximum of the set the specification defines.
 *
 * @param {import("../types").NodeKey} nodeKey
 * @param {ValueEvent | import("../records").DeleteEvent | undefined} winner
 */
class HeadSelectionClass {
    /**
     * @param {import("../types").NodeKey} nodeKey
     * @param {ValueEvent | import("../records").DeleteEvent | undefined} winner
     */
    constructor(nodeKey, winner) {
        this.nodeKey = nodeKey;
        this.winner = winner;
    }
}

/** @typedef {HeadSelectionClass} HeadSelection */

/**
 * The head of every semantic node the retained journal mentions.
 *
 * The result is keyed by canonical persisted NodeKey identity, which is the
 * identity the validation basis, the invalidation scopes and the current schema
 * all use, so no pass has to re-derive it.
 * @param {JournalSource} source
 * @returns {{selections: Map<string, HeadSelection>} | {error: JournalError}}
 */
function selectSemanticHeads(source) {
    /** @type {Map<string, HeadSelection>} */
    const selections = new Map();
    const failure = streamEveryRecord(source, (record) => {
        if (!isValueEvent(record) && !isDeleteEvent(record)) {
            return;
        }
        const nodeKeyString = nodeKeyToCanonicalString(record.node);
        const existing = selections.get(nodeKeyString);
        if (existing === undefined) {
            selections.set(nodeKeyString, new HeadSelectionClass(record.node, record));
            return;
        }
        const incumbent = existing.winner;
        if (incumbent === undefined || authorityCompare(record, incumbent) > 0) {
            selections.set(nodeKeyString, new HeadSelectionClass(existing.nodeKey, record));
        }
    });
    if (failure !== undefined) {
        return { error: failure };
    }
    return { selections };
}

/**
 * The selected `ValueId` of a node, or `undefined` when the node is absent.
 * @param {Map<string, HeadSelection>} selections
 * @param {string} nodeKeyString
 * @returns {import("../types").JournalRecordId | undefined}
 */
function selectedValueId(selections, nodeKeyString) {
    const selection = selections.get(nodeKeyString);
    if (selection === undefined || selection.winner === undefined) {
        return undefined;
    }
    return isValueEvent(selection.winner) ? selection.winner.id : undefined;
}

/**
 * Is the node present, meaning its selected head is a `ValueEvent`?
 * @param {Map<string, HeadSelection>} selections
 * @param {string} nodeKeyString
 * @returns {boolean}
 */
function isPresent(selections, nodeKeyString) {
    const selection = selections.get(nodeKeyString);
    return selection !== undefined && isValueEvent(selection.winner);
}

module.exports = {
    HeadSelectionClass,
    isPresent,
    selectSemanticHeads,
    selectedValueId,
};
