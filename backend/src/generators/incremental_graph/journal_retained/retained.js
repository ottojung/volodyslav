/**
 * The retained replay state reset folds its delta into, and the delta projection
 * each of reset's named cuts is read at.
 *
 * `incremental-graph-journal-reset.md` §Pass 1 closure guarantee requires the
 * `P1` state to be computed as a delta over the reset-affected closure using
 * retained projection/index state, observationally equal to `project(J1)`, and
 * forbids replaying or revalidating unrelated retained history. §Pass 2 requires
 * the post-barrier affected state to be obtained the same way, and §Pass 3 names
 * `P2` as the resulting state "needed for the affected reset closure". This module
 * is that mechanism: the activated replica's per-node replay state, and a fold
 * which extends it by the records reset admits or authors.
 *
 * What "retained projection/index state" means here is deliberately concrete. A
 * cut needs, per semantic node:
 *
 * - the greatest `ValueEvent` or `DeleteEvent` under `authorityCompare`, because a
 *   new head candidate is decided against the incumbent and a losing candidate
 *   never returns;
 * - every admitted `ValidateEvent` for the node, because a barrier or an input
 *   occurrence change can promote a certificate which was losing, so the winner
 *   cannot be remembered as one record;
 * - the coordinate maxima of the admitted invalidations, keyed by the scope each
 *   one declares; and
 * - the selected certificate the previous cut resolved, because a node outside the
 *   affected closure cannot change its answer.
 *
 * The first three are exactly the counted proof summary of
 * `incremental-graph-journal-storage.md` §Change-bounded proof summary, which the
 * activated replica already has to maintain, plus the head selection. The
 * unresolved cut is the retained head index, which the same section lists as an
 * optional derived index ("candidate head/certificate/invalidation indexes") and
 * permits to be used to obtain these costs when it is maintained incrementally.
 * `buildRetainedReplayState` is the maintenance traversal which constructs the
 * whole of it; like `buildProofSummary` it belongs to publication, maintenance or
 * migration, and reset never calls it.
 *
 * The fold is O(C) in the admitted delta plus the graph-sized closure and
 * resolution work §Streamability permits. It reads no retained record.
 */

/** @typedef {import('../journal/errors').AnyJournalError} JournalError */
/** @typedef {import('../journal/records').DeleteEvent} DeleteEvent */
/** @typedef {import('../journal/records').JournalRecord} JournalRecord */
/** @typedef {import('../journal/records').ValidateEvent} ValidateEvent */
/** @typedef {import('../journal/records').ValueEvent} ValueEvent */
/** @typedef {import('../journal/types').JournalAuthor} JournalAuthor */
/** @typedef {import('../journal/types').JournalRecordId} JournalRecordId */
/** @typedef {import('../journal/types').JournalSequence} JournalSequence */
/** @typedef {import('../journal/types').NodeKey} NodeKey */
/** @typedef {import('../journal/oracle/certificates').SelectedCertificate} SelectedCertificate */
/** @typedef {import('../journal/oracle/heads').HeadSelection} HeadSelection */
/** @typedef {import('../journal/oracle/invalidations').InvalidationSummary} InvalidationSummary */
/** @typedef {import('../journal/oracle/projection').NodeFreshness} NodeFreshness */
/** @typedef {import('../journal/oracle/projection').ProjectedOccurrence} ProjectedOccurrence */
/** @typedef {import('../journal/oracle/projection').Projection} Projection */
/** @typedef {import('../journal/oracle/record_source').JournalSource} JournalSource */
/** @typedef {import('./proof_summary').CurrentInputKeysOfNode} CurrentInputKeysOfNode */
/** @typedef {import('./proof_summary').ProofSummary} ProofSummary */

const {
    authorityCompare,
    compareCertificates,
    compareJournalSequence,
    coversValueInvalidations,
    deriveFreshness,
    effectiveInputsOf,
    HeadSelectionClass,
    isDeleteEvent,
    isEligibleCertificate,
    isValueEvent,
    isWriterStateRecord,
    journalAuthorToString,
    journalRecordIdToString,
    nodeKeyToCanonicalString,
    occurrenceOf,
    ProjectionClass,
    selfProofReady,
    SelectedCertificateClass,
    validateDependencyClosure,
    validateNodeIdentifierDistinctness,
} = require("../journal");
const {
    invalidationViewOf,
    selectOccurrences,
    stageAdmittedRecords,
} = require("./proof_summary");

/**
 * @param {RetainedReplayState} state
 * @returns {(name: string) => JournalAuthor | undefined}
 */
function authorOf(state) {
    return (name) => state.writers.get(name);
}

/**
 * The properties that this class carries are:
 * - `heads` holds, per semantic node, the greatest `ValueEvent` or `DeleteEvent`
 *   over every admitted record for that node, which is the specification's
 *   `selectedHeads` view of the admitted state;
 * - `proofs` holds the counted proof summary of the admitted state, so every
 *   admitted validation and the invalidation coordinate maxima are reachable
 *   without a record;
 * - `certificates` holds the resolved certificate of each node of the last
 *   projected cut;
 * - `selected` holds the selected occurrence of each node of the last projected
 *   cut, which is what makes the next fold's closure the nodes whose occurrence
 *   actually changed;
 * - `writers` names every writer the admitted state retains, which is what the
 *   causal-coverage comparisons resolve frontier coordinates against;
 * - `admittedLengths` names, per writer, the greatest coordinate the admitted state
 *   has seen, which is what says how much of that writer's stream the state has
 *   admitted and therefore which journal the state describes;
 * - `lastNodeIndex` is the local writer's allocator watermark over the admitted
 *   state; and
 * - `touched` names the nodes the records staged since the last projection name,
 *   which is the other half of the affected closure.
 *
 * The proof of those properties is guaranteed by:
 * - `buildRetainedReplayState(request)`: it visits every retained record once,
 *   replacing a node's stored head candidate exactly when the arriving candidate
 *   is greater under `authorityCompare`, which makes each stored candidate the
 *   maximum of the set `incremental-graph-journal-replay.md` §Semantic value/
 *   absence head defines, and it admits every retained validation and invalidation
 *   into the counted proof summary by the same traversal, recording each record's
 *   own coordinate in `admittedLengths`; and
 * - `projectRetainedReplay(state)`: it resolves every node of the affected closure
 *   from those stored candidates and maxima, then stores the resolution as
 *   `certificates` and `selected`, so the two describe one and the same cut; and
 * - `stageRetainedRecords(state, records)`: each staged record either enters the
 *   head candidates, the proof summary and `touched`, or is an own-writer
 *   `WriterStateRecord` which raises `lastNodeIndex`, and every record's author
 *   enters `writers` and its coordinate raises `admittedLengths` for that author,
 *   so the statements hold over the extended admitted state.
 *
 * `incremental-graph-journal-storage.md` §Change-bounded proof summary requires a
 * missing or stale summary to be rebuilt or maintained rather than consumed, so the
 * state is only usable for a journal whose per-writer retained lengths are the ones
 * `admittedLengths` names. `correspondence.js` decides that comparison, and it is
 * what refuses a state which does not describe the journal it is asked about.
 *
 * @param {Map<string, HeadSelection>} heads
 * @param {ProofSummary} proofs
 * @param {Map<string, SelectedCertificate>} certificates
 * @param {Map<string, JournalRecordId>} selected
 * @param {Set<string>} touched
 * @param {Map<string, JournalAuthor>} writers
 * @param {Map<string, JournalSequence>} admittedLengths
 * @param {number} lastNodeIndex
 * @param {JournalAuthor} localWriter
 * @param {CurrentInputKeysOfNode} currentInputKeysOfNode
 */
class RetainedReplayStateClass {
    /**
     * @param {Map<string, HeadSelection>} heads
     * @param {ProofSummary} proofs
     * @param {Map<string, SelectedCertificate>} certificates
     * @param {Map<string, JournalRecordId>} selected
     * @param {Set<string>} touched
     * @param {Map<string, JournalAuthor>} writers
     * @param {Map<string, JournalSequence>} admittedLengths
     * @param {number} lastNodeIndex
     * @param {JournalAuthor} localWriter
     * @param {CurrentInputKeysOfNode} currentInputKeysOfNode
     */
    constructor(
        heads,
        proofs,
        certificates,
        selected,
        touched,
        writers,
        admittedLengths,
        lastNodeIndex,
        localWriter,
        currentInputKeysOfNode
    ) {
        this.heads = heads;
        this.proofs = proofs;
        this.certificates = certificates;
        this.selected = selected;
        this.touched = touched;
        this.writers = writers;
        this.admittedLengths = admittedLengths;
        this.lastNodeIndex = lastNodeIndex;
        this.localWriter = localWriter;
        this.currentInputKeysOfNode = currentInputKeysOfNode;
    }
}

/** @typedef {RetainedReplayStateClass} RetainedReplayState */

/**
 * @param {unknown} value
 * @returns {value is RetainedReplayState}
 */
function isRetainedReplayState(value) {
    return value instanceof RetainedReplayStateClass;
}

/**
 * The writer lookup the causal-coverage comparisons resolve frontier coordinates
 * against.
 *
 * @param {RetainedReplayState} state
 * @returns {(name: string) => JournalAuthor | undefined}
 */
function authorLookupOf(state) {
    return authorOf(state);
}

/**
 * The `selectedHeads` view of the admitted state.
 *
 * @param {RetainedReplayState} state
 * @returns {Map<string, HeadSelection>}
 */
function selectedHeadsOf(state) {
    return state.heads;
}

/**
 * The selected occurrences of the admitted state, as the passes compare against.
 *
 * @param {RetainedReplayState} state
 * @returns {Map<string, {node: NodeKey, valueId: JournalRecordId}>}
 */
function selectedOccurrencesOf(state) {
    /** @type {Map<string, {node: NodeKey, valueId: JournalRecordId}>} */
    const selected = new Map();
    for (const [nodeKeyString, selection] of state.heads) {
        const winner = selection.winner;
        if (winner === undefined || !isValueEvent(winner)) {
            continue;
        }
        selected.set(nodeKeyString, { node: selection.nodeKey, valueId: winner.id });
    }
    return selected;
}

/**
 * The invalidation view replay's own predicates read, for one node and the
 * occurrence that is current in the admitted state.
 *
 * @param {RetainedReplayState} state
 * @param {string} nodeKeyString
 * @param {JournalRecordId | undefined} valueId
 * @returns {InvalidationSummary}
 */
function invalidationSummaryOf(state, nodeKeyString, valueId) {
    if (valueId === undefined) {
        return invalidationViewOf(state.proofs, nodeKeyString, "");
    }
    return invalidationViewOf(state.proofs, nodeKeyString, journalRecordIdToString(valueId));
}

/**
 * @param {Map<string, HeadSelection>} heads
 * @param {string} nodeKeyString
 * @returns {JournalRecordId | undefined}
 */
function selectedValueIdOf(heads, nodeKeyString) {
    const selection = heads.get(nodeKeyString);
    if (selection === undefined) {
        return undefined;
    }
    const winner = selection.winner;
    return winner === undefined || !isValueEvent(winner) ? undefined : winner.id;
}

/**
 * Offer one record to the retained head candidates.
 *
 * A losing candidate stays history and is never consulted again, because the stored
 * candidate is a running maximum under `authorityCompare`.
 *
 * @param {Map<string, HeadSelection>} heads
 * @param {JournalRecord} record
 */
function admitRetainedHead(heads, record) {
    if (!isValueEvent(record) && !isDeleteEvent(record)) {
        return;
    }
    const nodeKeyString = nodeKeyToCanonicalString(record.node);
    const existing = heads.get(nodeKeyString);
    if (existing === undefined) {
        heads.set(nodeKeyString, new HeadSelectionClass(record.node, record));
        return;
    }
    const incumbent = existing.winner;
    if (incumbent === undefined || authorityCompare(record, incumbent) > 0) {
        heads.set(nodeKeyString, new HeadSelectionClass(existing.nodeKey, record));
    }
}

/**
 * Record that the admitted state has seen a record of one writer at one coordinate.
 *
 * The admitted length of a writer is the greatest coordinate the state admits, which
 * is the same value the receiver's own retained length of that writer names once the
 * records are published. `correspondence.js` compares the two.
 *
 * @param {Map<string, JournalSequence>} admittedLengths - The state field to raise.
 * @param {string} name
 * @param {JournalSequence} sequence
 */
function raiseAdmittedLength(admittedLengths, name, sequence) {
    const existing = admittedLengths.get(name);
    if (existing === undefined || compareJournalSequence(sequence, existing) > 0) {
        admittedLengths.set(name, sequence);
    }
}

/**
 * Admit records into the retained replay state, as import or reset authorship does.
 *
 * @param {RetainedReplayState} state - The staged state to extend in place.
 * @param {ReadonlyArray<JournalRecord>} records
 */
function stageRetainedRecords(state, records) {
    const localName = journalAuthorToString(state.localWriter);
    for (const record of records) {
        const name = journalAuthorToString(record.id.author);
        state.writers.set(name, record.id.author);
        raiseAdmittedLength(state.admittedLengths, name, record.id.sequence);
        if (isWriterStateRecord(record)) {
            if (journalAuthorToString(record.id.author) === localName) {
                state.lastNodeIndex = record.lastNodeIndex;
            }
            continue;
        }
        state.touched.add(nodeKeyToCanonicalString(record.node));
        admitRetainedHead(state.heads, record);
    }
    stageAdmittedRecords({ summary: state.proofs, records });
}

/**
 * The nodes whose resolved certificate can have changed since the last cut.
 *
 * A node is affected when it is named by an admitted record, when its own selected
 * occurrence changed, or when one of its current direct inputs did, because a
 * certificate is decided by its own occurrence, its own invalidations and the
 * current occurrences of its inputs. The closure is taken over the current schema
 * DAG, so a change to a leaf reaches every node whose freshness or proof it feeds.
 *
 * @param {RetainedReplayState} state
 * @param {Map<string, JournalRecordId>} selected
 * @param {ReadonlyArray<string>} nodeKeyStrings
 * @returns {Set<string>}
 */
function affectedClosure(state, selected, nodeKeyStrings) {
    /** @type {Map<string, string[]>} */
    const dependents = new Map();
    for (const nodeKeyString of nodeKeyStrings) {
        const inputs = state.currentInputKeysOfNode(nodeKeyString);
        for (const inputKeyString of inputs) {
            const existing = dependents.get(inputKeyString);
            if (existing === undefined) {
                dependents.set(inputKeyString, [nodeKeyString]);
            } else {
                existing.push(nodeKeyString);
            }
        }
    }
    /** @type {Set<string>} */
    const affected = new Set(state.touched);
    /** @type {string[]} */
    const frontier = [];
    for (const nodeKeyString of nodeKeyStrings) {
        const was = state.selected.get(nodeKeyString);
        const now = selected.get(nodeKeyString);
        if (was === undefined && now === undefined) {
            continue;
        }
        if (
            was === undefined ||
            now === undefined ||
            journalRecordIdToString(was) !== journalRecordIdToString(now)
        ) {
            affected.add(nodeKeyString);
            frontier.push(nodeKeyString);
        }
    }
    while (frontier.length > 0) {
        const current = frontier.pop();
        if (current === undefined) {
            break;
        }
        for (const dependent of dependents.get(current) ?? []) {
            if (affected.has(dependent)) {
                continue;
            }
            affected.add(dependent);
            frontier.push(dependent);
        }
    }
    return affected;
}

/**
 * The certificate the admitted candidates and maxima resolve to for one node.
 *
 * The predicates are replay's own, so eligibility, effectiveness and the ordering
 * are decided by one implementation of those clauses rather than by a second one.
 *
 * @param {RetainedReplayState} state
 * @param {string} nodeKeyString
 * @param {Map<string, JournalRecordId>} selected
 * @returns {SelectedCertificate | undefined}
 */
function resolveCertificate(state, nodeKeyString, selected) {
    const valueId = selected.get(nodeKeyString);
    if (valueId === undefined) {
        return undefined;
    }
    const candidates = state.proofs.certificates.get(nodeKeyString);
    if (candidates === undefined) {
        return undefined;
    }
    const summaries = new Map([
        [nodeKeyString, invalidationViewOf(state.proofs, nodeKeyString, journalRecordIdToString(valueId))],
    ]);
    const occurrences = {
        valueIdOf: (/** @type {string} */ key) => selected.get(key),
        authorOf: authorOf(state),
    };
    /** @type {SelectedCertificate | undefined} */
    let winner;
    for (const candidate of candidates.values()) {
        if (!isEligibleCertificate(candidate, summaries, occurrences, state.currentInputKeysOfNode)) {
            continue;
        }
        const challenger = new SelectedCertificateClass(
            candidate,
            effectiveInputsOf(candidate, summaries, occurrences, state.currentInputKeysOfNode),
            coversValueInvalidations(candidate, summaries, occurrences)
        );
        if (winner === undefined || compareCertificates(winner, challenger)) {
            winner = challenger;
        }
    }
    return winner;
}

/**
 * Project the admitted state as a delta over the affected closure.
 *
 * The result is the projection of the whole admitted state, so a pass may read any
 * node of it, but only the affected closure is resolved: a node outside the
 * closure has the same occurrence, the same admitted invalidations and the same
 * input occurrences as at the previous cut, so its certificate resolves to the one
 * that cut stored.
 *
 * @param {RetainedReplayState} state - The staged state, resolved in place.
 * @returns {Projection | {error: JournalError}}
 */
function projectRetainedReplay(state) {
    const inputsOf = state.currentInputKeysOfNode;
    const nodeKeyStrings = [...state.heads.keys()].sort();
    /** @type {Map<string, JournalRecordId>} */
    const selected = new Map();
    for (const nodeKeyString of nodeKeyStrings) {
        const valueId = selectedValueIdOf(state.heads, nodeKeyString);
        if (valueId !== undefined) {
            selected.set(nodeKeyString, valueId);
        }
    }
    const affected = affectedClosure(state, selected, nodeKeyStrings);
    for (const nodeKeyString of affected) {
        const certificate = resolveCertificate(state, nodeKeyString, selected);
        if (certificate === undefined) {
            state.certificates.delete(nodeKeyString);
        } else {
            state.certificates.set(nodeKeyString, certificate);
        }
    }
    const closure = validateDependencyClosure(state.heads, inputsOf);
    if (closure !== undefined) {
        return { error: closure };
    }
    const identifiers = validateNodeIdentifierDistinctness(state.heads);
    if (identifiers !== undefined) {
        return { error: identifiers };
    }
    const freshness = deriveFreshness({
        selections: state.heads,
        certificates: state.certificates,
        nodeKeyStrings,
        currentInputKeysOfNode: inputsOf,
    });
    if ("error" in freshness) {
        return { error: freshness.error };
    }
    /** @type {ProjectedOccurrence[]} */
    const projected = [];
    for (const nodeKeyString of nodeKeyStrings) {
        const selection = state.heads.get(nodeKeyString);
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
        if (!selfProofReady(nodeKeyString, state.heads, state.certificates, inputsOf)) {
            continue;
        }
        selfProofReadyNodes.add(nodeKeyString);
        const nodeFreshness = freshness.freshness.get(nodeKeyString);
        if (nodeFreshness !== undefined && !nodeFreshness.fresh) {
            unmarkedPropagatedStaleness.add(nodeKeyString);
        }
    }
    state.selected = selected;
    state.touched.clear();
    selectOccurrences({
        summary: state.proofs,
        occurrences: selectedOccurrencesOf(state),
    });
    return new ProjectionClass(
        projected,
        freshness.freshness,
        state.lastNodeIndex,
        state.localWriter,
        selfProofReadyNodes,
        unmarkedPropagatedStaleness
    );
}

module.exports = {
    RetainedReplayStateClass,
    admitRetainedHead,
    raiseAdmittedLength,
    authorLookupOf,
    invalidationSummaryOf,
    isRetainedReplayState,
    projectRetainedReplay,
    selectedHeadsOf,
    selectedOccurrencesOf,
    stageRetainedRecords,
};