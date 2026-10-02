/**
 * The streaming `project(J)` reference oracle.
 *
 * `incremental-graph-journal-replay.md` §Inputs to replay defines
 * `project(journal, localWriter, currentGraphSchema)`. This module is that
 * function, written as a reference model: deliberately straightforward, and
 * streaming.
 *
 * It runs a constant number of ordered streaming passes over the retained journal
 * and one graph-sized resolution:
 *
 * 1. **context.** One pass checking the two context conditions which are
 *    decidable from one record and the source's retained lengths.
 * 2. **heads.** One pass, one running candidate per node. This is the only pass
 *    which decides anything about a node's *occurrence*.
 * 3. **invalidation summaries.** One pass, one per-writer maximum per
 *    (node, scope) which the selected occurrences make relevant. This is what
 *    turns §Invalidation coverage's set existentials into frontier comparisons.
 * 4. **certificates.** One pass, one winner per node, each candidate's ordering
 *    keys computed from the certificate and the summaries alone.
 * 5. **freshness and lowering.** A resolution over the current schema DAG of the
 *    graph-sized summaries, reading no retained record.
 *
 * The passes are ordered because each needs the previous one's answer: a
 * certificate's eligibility depends on the selected occurrence, and the selected
 * occurrence depends on nothing but authority. Every pass re-reads the source
 * through the per-writer reader, so the pass count is a constant and the working
 * set is graph-sized rather than history-sized.
 *
 * The local writer's allocator watermark rides along with the context pass,
 * because it is the one piece of state which is neither graph-sized nor
 * order-dependent: it is the maximum `lastNodeIndex` over the local writer's own
 * records, and reading only that writer's prefix keeps a foreign watermark out of
 * it.
 *
 * A retained journal must already be well formed under
 * `incremental-graph-journal-well-formedness.md`. The oracle consumes that
 * contract rather than re-running the record layer's validators, because doing so
 * would be a second full traversal of history to re-derive what
 * `../well_formedness` already establishes, and would make the oracle a
 * transcription of those validators instead of an independent reader of the
 * replay specification. The no-holes and no-forks conditions are not consumed:
 * they are consequences of the prefix-union merge, which fails inside the merge.
 *
 * `localWriter` reconstructs the host-local allocator projection and affects
 * nothing else. No semantic pass consults it.
 */

const { isValueEvent, isWriterStateRecord } = require("../records");
const { journalAuthorToString } = require("../types");
const { streamWithReport, validateContextClaim } = require("./scan");
const { isPresent, selectSemanticHeads, selectedValueId } = require("./heads");
const { summarizeInvalidations } = require("./invalidations");
const { selectCertificates } = require("./certificates");
const {
    deriveFreshness,
    occurrenceOf,
    ProjectionClass,
    selfProofReady,
    validateDependencyClosure,
    validateNodeIdentifierDistinctness,
} = require("./projection");

/** @typedef {import("../errors").AnyJournalError} JournalError */
/** @typedef {import("../records").ValueEvent} ValueEvent */
/** @typedef {import("../types").JournalAuthor} JournalAuthor */
/** @typedef {import("../types").JournalRecordId} JournalRecordId */
/** @typedef {import("../types").NodeKey} NodeKey */
/** @typedef {import("./record_source").JournalSource} JournalSource */
/** @typedef {import("./projection").Projection} Projection */

/**
 * The current schema's direct inputs of one node, keyed by canonical persisted
 * NodeKey identity. A node which is not in the current schema has no entry.
 * @callback CurrentInputKeysOfNode
 * @param {string} nodeKeyString
 * @returns {ReadonlyArray<string> | undefined}
 */

/**
 * @typedef {object} ProjectOptions
 * @property {JournalSource} source - The retained journal, read one writer
 *   prefix at a time.
 * @property {JournalAuthor} localWriter - The writer whose host-local allocator
 *   projection is reconstructed. It affects only `lastNodeIndex`.
 * @property {CurrentInputKeysOfNode} currentInputKeysOfNode - The current
 *   schema's direct inputs per node.
 */

/**
 * The writer name to writer identity index, for the frontier comparisons which
 * name a writer rather than hold one.
 * @param {JournalSource} source
 * @returns {Map<string, JournalAuthor>}
 */
function authorIndex(source) {
    /** @type {Map<string, JournalAuthor>} */
    const index = new Map();
    for (const author of source.writers()) {
        index.set(journalAuthorToString(author), author);
    }
    return index;
}

/**
 * Check every retained semantic event's context claim, and read the local
 * writer's allocator watermark in the same pass.
 *
 * The watermark is the maximum `lastNodeIndex` over the local writer's own
 * `WriterStateRecord`s, which is the greatest one by sequence because the
 * retained stream is monotone nondecreasing. A writer with no such record uses
 * the defined initial zero.
 * @param {JournalSource} source
 * @param {JournalAuthor} localWriter
 * @returns {{watermark: number} | {error: JournalError}}
 */
function readContextAndWatermark(source, localWriter) {
    const localName = journalAuthorToString(localWriter);
    let watermark = 0;
    const failure = streamWithReport(source, (record) => {
        if (isWriterStateRecord(record)) {
            if (journalAuthorToString(record.id.author) === localName) {
                watermark = record.lastNodeIndex;
            }
            return undefined;
        }
        return validateContextClaim(record, source);
    });
    if (failure !== undefined) {
        return { error: failure };
    }
    return { watermark };
}

/**
 * Project a retained journal into current graph state.
 * @param {ProjectOptions} options
 * @returns {Projection | JournalError}
 */
function projectRetainedJournal(options) {
    const { source, localWriter } = options;
    const currentInputKeysOfNode = options.currentInputKeysOfNode;
    /**
     * @param {string} nodeKeyString
     * @returns {ReadonlyArray<string>}
     */
    const inputsOf = (nodeKeyString) => {
        const current = currentInputKeysOfNode(nodeKeyString);
        return current === undefined ? [] : current;
    };
    const names = authorIndex(source);

    const head = readContextAndWatermark(source, localWriter);
    if ("error" in head) {
        return head.error;
    }

    const heads = selectSemanticHeads(source);
    if ("error" in heads) {
        return heads.error;
    }
    const nodeKeyStrings = [...heads.selections.keys()].sort();
    const closureFailure = validateDependencyClosure(heads.selections, inputsOf);
    if (closureFailure !== undefined) {
        return closureFailure;
    }
    const identifierFailure = validateNodeIdentifierDistinctness(heads.selections);
    if (identifierFailure !== undefined) {
        return identifierFailure;
    }

    /** @type {Map<string, {node: NodeKey, valueId: JournalRecordId}>} */
    const selectedOccurrences = new Map();
    for (const nodeKeyString of nodeKeyStrings) {
        const valueId = selectedValueId(heads.selections, nodeKeyString);
        if (valueId === undefined) {
            continue;
        }
        const selection = heads.selections.get(nodeKeyString);
        if (selection === undefined) {
            continue;
        }
        selectedOccurrences.set(nodeKeyString, { node: selection.nodeKey, valueId });
    }

    const invalidations = summarizeInvalidations(source, selectedOccurrences);
    if ("error" in invalidations) {
        return invalidations.error;
    }

    const certificates = selectCertificates(source, {
        occurrences: {
            valueIdOf: (nodeKeyString) => selectedValueId(heads.selections, nodeKeyString),
            authorOf: (name) => names.get(name),
        },
        summaries: invalidations.summaries,
        currentInputKeysOfNode,
    });
    if ("error" in certificates) {
        return certificates.error;
    }

    const freshness = deriveFreshness({
        selections: heads.selections,
        certificates: certificates.certificates,
        nodeKeyStrings,
        currentInputKeysOfNode: inputsOf,
    });
    if ("error" in freshness) {
        return freshness.error;
    }

    /** @type {import("./projection").ProjectedOccurrence[]} */
    const projected = [];
    for (const nodeKeyString of nodeKeyStrings) {
        if (!isPresent(heads.selections, nodeKeyString)) {
            continue;
        }
        const selection = heads.selections.get(nodeKeyString);
        const nodeFreshness = freshness.freshness.get(nodeKeyString);
        if (selection === undefined || nodeFreshness === undefined) {
            continue;
        }
        const winner = selection.winner;
        if (winner === undefined || !isValueEvent(winner)) {
            continue;
        }
        projected.push(occurrenceOf(winner, nodeKeyString, nodeFreshness));
    }
    const selfProofReadyNodes = new Set();
    const unmarkedPropagatedStaleness = new Set();
    for (const nodeKeyString of nodeKeyStrings) {
        if (!selfProofReady(nodeKeyString, heads.selections, certificates.certificates, inputsOf)) {
            continue;
        }
        selfProofReadyNodes.add(nodeKeyString);
        const nodeFreshness = freshness.freshness.get(nodeKeyString);
        if (nodeFreshness !== undefined && !nodeFreshness.fresh) {
            unmarkedPropagatedStaleness.add(nodeKeyString);
        }
    }
    return new ProjectionClass(
        projected,
        freshness.freshness,
        head.watermark,
        localWriter,
        selfProofReadyNodes,
        unmarkedPropagatedStaleness
    );
}

module.exports = {
    authorIndex,
    projectRetainedJournal,
    readContextAndWatermark,
};
