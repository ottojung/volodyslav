/**
 * The change-bounded proof summary: the counted, per-occurrence, per-edge index.
 *
 * `incremental-graph-journal-storage.md` §Change-bounded proof summary requires
 * active/staged Journal state to provide, or to be accompanied by, an
 * incrementally maintained derived summary equivalent to
 *
 * ```text
 * eligibleProofEdgeCount(K,V,D) =
 *     number of current-shape-compatible ValidateEvents C
 *     for node K and occurrence V
 *     which are eligible under current node-invalidations
 *     and for which basis entry D is effective against
 *     the current input occurrence and proof barriers
 * ```
 *
 * and states that `reset`, `synchronization` and routine open MUST NOT fall back
 * to scanning retained history to obtain it. This module is that index. Its read,
 * `eligibleProofEdgeUnion`, answers over the admitted state the summary holds and
 * never visits a record; its writes are per admitted record
 * (`stageAdmittedRecords`) and per selected-occurrence change
 * (`selectOccurrences`). Nothing here is proportional to the retained history.
 *
 * Two properties are worth stating because they are what make the index countable
 * rather than boolean, which is why the specification asks for a count:
 *
 * - a certificate of an occurrence which is not currently selected stays in the
 *   index, so replacing an occurrence and later selecting the previous one again
 *   needs no index repair. A count of zero for a losing occurrence is what
 *   `selected` expresses, and it is why retiring one certificate's edge while
 *   another still proves it leaves the edge counted;
 * - a proof barrier is stored as a coordinate maximum per `(K, V, D)`, so a
 *   certificate which causally observes the barrier keeps counting that edge,
 *   because re-establishing a barriered edge is proving it again.
 *
 * The counts are derived on read from the admitted state rather than cached, so
 * no cached count can disagree with the state it summarises, and eligibility and
 * effectiveness are decided by replay's own predicates instead of a second
 * implementation of them.
 *
 * `buildProofSummary` is the maintenance entry the specification allows for a
 * missing or stale summary. It traverses a journal and belongs to publication,
 * maintenance or migration, never to reset.
 */

/** @typedef {import('../journal/errors').AnyJournalError} JournalError */
/** @typedef {import('../journal/records').InvalidateEvent} InvalidateEvent */
/** @typedef {import('../journal/records').JournalRecord} JournalRecord */
/** @typedef {import('../journal/records').ValidateEvent} ValidateEvent */
/** @typedef {import('../journal/types').JournalAuthor} JournalAuthor */
/** @typedef {import('../journal/types').JournalRecordId} JournalRecordId */
/** @typedef {import('../database/node_key').NodeKey} NodeKey */
/** @typedef {import('../journal/oracle/invalidations').CoordinateMaximum} CoordinateMaximum */
/** @typedef {import('../journal/oracle/invalidations').InvalidationSummary} InvalidationSummary */
/** @typedef {import('../journal/oracle/record_source').JournalSource} JournalSource */

const {
    compareJournalSequence,
    effectiveInputsOf,
    isEligibleCertificate,
    isInvalidateEvent,
    isValidateEvent,
    journalAuthorToString,
    journalRecordIdToString,
    nodeKeyToCanonicalString,
    streamWithReport,
} = require("../journal");

/**
 * The writer lookup a causal-coverage comparison resolves frontier coordinates
 * against.
 *
 * @typedef {(name: string) => JournalAuthor | undefined} AuthorLookup
 */

/**
 * The current inputs of a node in the current schema.
 *
 * @typedef {(nodeKeyString: string) => ReadonlyArray<string>} CurrentInputKeysOfNode
 */

/**
 * The properties that this class carries are:
 * - `selected` is the selected occurrence of every node this summary counts for.
 * - `certificates` holds, per node, every admitted `ValidateEvent` for that node,
 *   whether or not the occurrence it names is currently selected.
 * - `nodeScoped`, `valueScoped` and `proofScoped` hold the coordinate maxima of
 *   the admitted invalidations, keyed by the scope each one declares: a node, a
 *   `(node, occurrence)` or a `(node, occurrence, input)`. Keying them by the
 *   declared scope rather than by the selected occurrence is what lets a barrier
 *   for one `ValueId` leave another `ValueId`'s proof alone.
 *
 * The proof of those properties is guaranteed by:
 * - `buildProofSummary(request)`: it records the selected occurrences the caller
 *   supplies, then visits every retained record once, admitting each validation
 *   into `certificates` and each invalidation into the maximum its own scope
 *   names; and
 * - `stageAdmittedRecords(request)` and `selectOccurrences(request)`: each admits
 *   or drops exactly the entries its own arguments name, so after either call the
 *   same statements hold over the extended admitted state.
 *
 * @param {Map<string, JournalRecordId>} selected
 * @param {CurrentInputKeysOfNode} currentInputKeysOfNode
 * @param {Map<string, Map<string, ValidateEvent>>} certificates
 * @param {Map<string, CoordinateMaximum>} nodeScoped
 * @param {Map<string, Map<string, CoordinateMaximum>>} valueScoped
 * @param {Map<string, Map<string, Map<string, CoordinateMaximum>>>} proofScoped
 */
class ProofSummaryClass {
    /**
     * @param {Map<string, JournalRecordId>} selected
     * @param {CurrentInputKeysOfNode} currentInputKeysOfNode
     * @param {Map<string, Map<string, ValidateEvent>>} certificates
     * @param {Map<string, CoordinateMaximum>} nodeScoped
     * @param {Map<string, Map<string, CoordinateMaximum>>} valueScoped
     * @param {Map<string, Map<string, Map<string, CoordinateMaximum>>>} proofScoped
     */
    constructor(selected, currentInputKeysOfNode, certificates, nodeScoped, valueScoped, proofScoped) {
        this.selected = selected;
        this.currentInputKeysOfNode = currentInputKeysOfNode;
        this.certificates = certificates;
        this.nodeScoped = nodeScoped;
        this.valueScoped = valueScoped;
        this.proofScoped = proofScoped;
    }
}

/** @typedef {ProofSummaryClass} ProofSummary */

/**
 * @param {unknown} value
 * @returns {value is ProofSummary}
 */
function isProofSummary(value) {
    return value instanceof ProofSummaryClass;
}

/**
 * @param {CoordinateMaximum} maximum
 * @param {JournalRecord} record
 */
function raiseCoordinate(maximum, record) {
    const writerName = journalAuthorToString(record.id.author);
    const existing = maximum.get(writerName);
    if (existing === undefined || compareJournalSequence(existing, record.id.sequence) < 0) {
        maximum.set(writerName, record.id.sequence);
    }
}

/**
 * The per-input maxima of the proof barriers one `(node, occurrence)` scope has
 * admitted, created on first use.
 *
 * @param {Map<string, Map<string, Map<string, CoordinateMaximum>>>} maxima
 * @param {string} nodeKeyString
 * @param {string} valueId
 * @returns {Map<string, CoordinateMaximum>}
 */
function proofBarriersOf(maxima, nodeKeyString, valueId) {
    const byValue = maxima.get(nodeKeyString);
    if (byValue !== undefined) {
        const existing = byValue.get(valueId);
        if (existing !== undefined) {
            return existing;
        }
    }
    /** @type {Map<string, CoordinateMaximum>} */
    const created = new Map();
    /** @type {Map<string, Map<string, CoordinateMaximum>>} */
    const scope = byValue === undefined ? new Map() : byValue;
    scope.set(valueId, created);
    maxima.set(nodeKeyString, scope);
    return created;
}

/**
 * The coordinate maximum of the value-scoped invalidations one `(node,
 * occurrence)` scope has admitted, created on first use.
 *
 * @param {Map<string, Map<string, CoordinateMaximum>>} maxima
 * @param {string} nodeKeyString
 * @param {string} valueId
 * @returns {CoordinateMaximum}
 */
function valueInvalidationsOf(maxima, nodeKeyString, valueId) {
    const byValue = maxima.get(nodeKeyString);
    if (byValue !== undefined) {
        const existing = byValue.get(valueId);
        if (existing !== undefined) {
            return existing;
        }
    }
    /** @type {CoordinateMaximum} */
    const created = new Map();
    /** @type {Map<string, CoordinateMaximum>} */
    const scope = byValue === undefined ? new Map() : byValue;
    scope.set(valueId, created);
    maxima.set(nodeKeyString, scope);
    return created;
}

/**
 * @param {ProofSummary} summary
 * @param {JournalRecord} record
 */
function admitRecord(summary, record) {
    if (isValidateEvent(record)) {
        const nodeKeyString = nodeKeyToCanonicalString(record.node);
        const existing = summary.certificates.get(nodeKeyString);
        if (existing === undefined) {
            const created = new Map();
            created.set(journalRecordIdToString(record.id), record);
            summary.certificates.set(nodeKeyString, created);
        } else {
            existing.set(journalRecordIdToString(record.id), record);
        }
        return;
    }
    if (!isInvalidateEvent(record)) {
        return;
    }
    admitInvalidation(summary, record);
}

/**
 * @param {ProofSummary} summary
 * @param {InvalidateEvent} record
 */
function admitInvalidation(summary, record) {
    const nodeKeyString = nodeKeyToCanonicalString(record.node);
    if (record.scope.kind === "node") {
        const existing = summary.nodeScoped.get(nodeKeyString);
        if (existing === undefined) {
            /** @type {CoordinateMaximum} */
            const created = new Map();
            summary.nodeScoped.set(nodeKeyString, created);
            raiseCoordinate(created, record);
            return;
        }
        raiseCoordinate(existing, record);
        return;
    }
    const valueId = journalRecordIdToString(record.scope.value);
    if (record.scope.kind === "value") {
        raiseCoordinate(valueInvalidationsOf(summary.valueScoped, nodeKeyString, valueId), record);
        return;
    }
    const byInput = proofBarriersOf(summary.proofScoped, nodeKeyString, valueId);
    const inputKeyString = nodeKeyToCanonicalString(record.scope.input);
    const existing = byInput.get(inputKeyString);
    if (existing === undefined) {
        /** @type {CoordinateMaximum} */
        const created = new Map();
        byInput.set(inputKeyString, created);
        raiseCoordinate(created, record);
        return;
    }
    raiseCoordinate(existing, record);
}

/**
 * @param {object} request
 * @param {JournalSource} request.source - The journal the summary is built from.
 * @param {Map<string, {node: NodeKey, valueId: JournalRecordId}>} request.occurrences
 *   - The selected occurrences of the cut the summary describes.
 * @param {CurrentInputKeysOfNode} request.currentInputKeysOfNode
 * @returns {{summary: ProofSummary} | {error: JournalError}}
 */
function buildProofSummary(request) {
    const { source, occurrences, currentInputKeysOfNode } = request;
    /** @type {Map<string, JournalRecordId>} */
    const selected = new Map();
    for (const [nodeKeyString, occurrence] of occurrences) {
        selected.set(nodeKeyString, occurrence.valueId);
    }
    const summary = new ProofSummaryClass(
        selected,
        currentInputKeysOfNode,
        new Map(),
        new Map(),
        new Map(),
        new Map()
    );
    const failure = streamWithReport(source, (record) => {
        admitRecord(summary, record);
        return undefined;
    });
    if (failure !== undefined) {
        return { error: failure };
    }
    return { summary };
}

/**
 * Record the selected occurrences of a cut.
 *
 * `incremental-graph-journal-storage.md` §Change-bounded proof summary requires
 * the summary to be updated whenever the selected occurrence changes. Because the
 * counts are derived from `selected` when they are read, selecting a different
 * occurrence needs no per-certificate repair and revisits no record.
 *
 * @param {object} request
 * @param {ProofSummary} request.summary - The summary to update in place.
 * @param {Map<string, {node: NodeKey, valueId: JournalRecordId}>} request.occurrences
 *   - The selected occurrences of the new cut.
 * @returns {{summary: ProofSummary}}
 */
function selectOccurrences(request) {
    const { summary, occurrences } = request;
    /** @type {Map<string, JournalRecordId>} */
    const selected = new Map();
    for (const [nodeKeyString, occurrence] of occurrences) {
        selected.set(nodeKeyString, occurrence.valueId);
    }
    summary.selected = selected;
    for (const nodeKeyString of [...summary.certificates.keys()]) {
        if (!occurrences.has(nodeKeyString)) {
            summary.certificates.delete(nodeKeyString);
        }
    }
    return { summary };
}

/**
 * Admit records into the summary, as publication, maintenance, import or reset
 * authorship does.
 *
 * Admission is per record and bounded by the current schema's arity, which is
 * what makes the summary change-bounded.
 *
 * @param {object} request
 * @param {ProofSummary} request.summary - The summary to update in place.
 * @param {ReadonlyArray<JournalRecord>} request.records
 * @returns {{summary: ProofSummary}}
 */
function stageAdmittedRecords(request) {
    for (const record of request.records) {
        admitRecord(request.summary, record);
    }
    return { summary: request.summary };
}

/**
 * The invalidation view replay's own predicates read, projected from this
 * summary's maxima for one node and one occurrence.
 *
 * The projection is what lets the count be decided by `isEligibleCertificate` and
 * `effectiveInputsOf` rather than by a second implementation of those clauses.
 *
 * @param {ProofSummary} summary
 * @param {string} nodeKeyString
 * @param {string} valueId
 * @returns {InvalidationSummary}
 */
function invalidationViewOf(summary, nodeKeyString, valueId) {
    const byValue = summary.proofScoped.get(nodeKeyString);
    return {
        nodeScoped: summary.nodeScoped.get(nodeKeyString) ?? new Map(),
        valueScoped: summary.valueScoped.get(nodeKeyString)?.get(valueId) ?? new Map(),
        proofScoped: byValue?.get(valueId) ?? new Map(),
    };
}

/**
 * `incremental-graph-journal-storage.md` §Change-bounded proof summary, read.
 *
 * @param {object} request
 * @param {ProofSummary} request.summary
 * @param {string} request.nodeKeyString
 * @param {string} request.valueId - The canonical record-id text of the occurrence.
 * @param {string} request.inputKeyString
 * @param {AuthorLookup} request.authorOf
 * @returns {number}
 */
function countEligibleProofEdges(request) {
    const { summary, nodeKeyString, valueId, inputKeyString, authorOf } = request;
    const selected = summary.selected.get(nodeKeyString);
    if (selected === undefined || journalRecordIdToString(selected) !== valueId) {
        return 0;
    }
    const certificates = summary.certificates.get(nodeKeyString);
    if (certificates === undefined) {
        return 0;
    }
    const view = invalidationViewOf(summary, nodeKeyString, valueId);
    const occurrences = {
        valueIdOf: (/** @type {string} */ nodeKeyString) => summary.selected.get(nodeKeyString),
        authorOf,
    };
    let count = 0;
    for (const certificate of certificates.values()) {
        if (journalRecordIdToString(certificate.value) !== valueId) {
            continue;
        }
        if (!isEligibleCertificate(
            certificate,
            new Map([[nodeKeyString, view]]),
            occurrences,
            summary.currentInputKeysOfNode
        )) {
            continue;
        }
        const effective = effectiveInputsOf(
            certificate,
            new Map([[nodeKeyString, view]]),
            occurrences,
            summary.currentInputKeysOfNode
        );
        if (effective.has(inputKeyString)) {
            count += 1;
        }
    }
    return count;
}

/**
 * The union of incoming edges any eligible retained certificate can prove for the
 * selected occurrence of a node.
 *
 * `incremental-graph-journal-reset.md` §Pass 2 writes this union as
 * `{ D | eligibleProofEdgeCount_P1(K, resetValueId(K), D) > 0 }`, and
 * `incremental-graph-journal-storage.md` §Change-bounded proof summary states
 * that for the selected occurrence `D` is in replay's maintenance union exactly
 * when the count is positive. This is that definition read from the counted
 * index, so a losing certificate's edges count exactly as much as a winning
 * certificate's.
 *
 * @param {object} request
 * @param {ProofSummary} request.summary
 * @param {string} request.nodeKeyString
 * @param {string} request.valueId - The canonical record-id text of the occurrence.
 * @param {AuthorLookup} request.authorOf
 * @returns {Set<string>}
 */
function eligibleProofEdgeUnion(request) {
    const { summary, nodeKeyString, valueId, authorOf } = request;
    /** @type {Set<string>} */
    const union = new Set();
    for (const inputKeyString of summary.currentInputKeysOfNode(nodeKeyString)) {
        if (countEligibleProofEdges({ summary, nodeKeyString, valueId, inputKeyString, authorOf }) > 0) {
            union.add(inputKeyString);
        }
    }
    return union;
}

module.exports = {
    ProofSummaryClass,
    buildProofSummary,
    countEligibleProofEdges,
    eligibleProofEdgeUnion,
    invalidationViewOf,
    isProofSummary,
    selectOccurrences,
    stageAdmittedRecords,
};
