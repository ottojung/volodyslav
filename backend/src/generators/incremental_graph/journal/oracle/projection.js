/**
 * Freshness, validity edges and the lowering to graph state.
 *
 * `incremental-graph-journal-replay.md` §Freshness defines freshness
 * recursively over the current schema DAG, §Incoming validity edge defines
 * `edgeValid`, and §Lowering to existing graph storage says how each derived
 * fact becomes persisted graph state.
 *
 * Freshness is recursive, and recursion needs the whole graph in hand, so this
 * pass is not a streaming pass. What makes it affordable is that it needs no
 * journal history at all: it consumes the three graph-sized summaries the
 * streaming passes produced — heads, certificates, and the current schema — and
 * the schema DAG is the recursion it walks. That is the shape the specification
 * allows under `$id-4924739474925738`: whole-replica *non-validation* graph work
 * is permitted, and no retained record is reread here.
 *
 * `selfProofReady(K) => fresh(K)` is checked as a derived outcome rather than
 * asserted: a node whose own proof is ready is fresh by construction, so the
 * check is a total function over the derived state which reports the nodes where
 * the committed invariant would be violated. Those nodes are the ones a
 * maintenance authoring path failed to mark.
 */

const { makeJournalProjectionError } = require("../errors");
const { nodeIdentifierToString } = require("../../database");
const { isValueEvent } = require("../records");
const { isPresent } = require("./heads");
const { isSelectedCertificate } = require("./certificates");

/** @typedef {import("../errors").AnyJournalError} JournalError */

/**
 * Is this node's own proof ready, meaning it could be fresh on its own evidence?
 *
 * A node is self-proof-ready when it is present, has a selected certificate,
 * proves every current input effectively, and causally covers every
 * value-scoped invalidation of its current occurrence.
 * @param {string} nodeKeyString
 * @param {Map<string, import("./heads").HeadSelection>} selections
 * @param {Map<string, import("./certificates").SelectedCertificate>} certificates
 * @param {(nodeKeyString: string) => ReadonlyArray<string>} currentInputKeysOfNode
 * @returns {boolean}
 */
function selfProofReady(nodeKeyString, selections, certificates, currentInputKeysOfNode) {
    if (!isPresent(selections, nodeKeyString)) {
        return false;
    }
    const selected = certificates.get(nodeKeyString);
    if (selected === undefined || !isSelectedCertificate(selected)) {
        return false;
    }
    if (!selected.coversValueInvalidations) {
        return false;
    }
    return selected.effectiveInputs.size === currentInputKeysOfNode(nodeKeyString).length;
}

/**
 * The properties that this class carries are:
 * - `fresh` is the specification's recursive freshness for the node, and
 *   `validInputs` is exactly the set of current direct inputs `D` for which
 *   `edgeValid(D, K)`.
 * - both are computed from graph-sized derived state only, so a value of this
 *   type never depends on a retained record being revisited.
 *
 * The proof of those properties is guaranteed by:
 * - `deriveFreshness(derived)`: defines `fresh` by the specification's own
 *   conjunction and resolves it over the current schema DAG, so a node with no
 *   selected certificate, an incomplete effective basis, an uncovered
 *   current-value invalidation, an absent input, or a stale input is fresh only
 *   when every conjunct holds. `validInputs` is exactly the inputs whose
 *   certificate entry is effective, which is `edgeValid` with both endpoints
 *   present.
 *
 * @param {boolean} fresh
 * @param {Set<string>} validInputs
 * @param {import("./certificates").SelectedCertificate | undefined} certificate
 */
class NodeFreshnessClass {
    /**
     * @param {boolean} fresh
     * @param {Set<string>} validInputs
     * @param {import("./certificates").SelectedCertificate | undefined} certificate
     */
    constructor(fresh, validInputs, certificate) {
        this.fresh = fresh;
        this.validInputs = validInputs;
        this.certificate = certificate;
    }
}

/** @typedef {NodeFreshnessClass} NodeFreshness */

/**
 * Is the current structural edge `D -> K` valid?
 *
 * A value-scoped invalidation does not by itself remove incoming proof, which is
 * what keeps proof validity separate from persistent stale freshness.
 * @param {string} inputKeyString
 * @param {string} nodeKeyString
 * @param {Map<string, import("./heads").HeadSelection>} selections
 * @param {Map<string, import("./certificates").SelectedCertificate>} certificates
 * @returns {boolean}
 */
function edgeValid(inputKeyString, nodeKeyString, selections, certificates) {
    if (!isPresent(selections, inputKeyString) || !isPresent(selections, nodeKeyString)) {
        return false;
    }
    const selected = certificates.get(nodeKeyString);
    if (selected === undefined) {
        return false;
    }
    return selected.effectiveInputs.has(inputKeyString);
}

/**
 * @param {unknown} value
 * @returns {value is NodeFreshness}
 */
function isNodeFreshness(value) {
    return value instanceof NodeFreshnessClass;
}

/**
 * The graph-sized derived state freshness is resolved over.
 * @typedef {object} FreshnessInput
 * @property {Map<string, import("./heads").HeadSelection>} selections
 * @property {Map<string, import("./certificates").SelectedCertificate>} certificates
 * @property {ReadonlyArray<string>} nodeKeyStrings - Every semantic node the
 *   journal mentions, in ascending canonical order.
 * @property {(nodeKeyString: string) => ReadonlyArray<string>} currentInputKeysOfNode
 */

/**
 * Resolve freshness over the current schema DAG.
 *
 * The schema is a DAG, so the resolution terminates; a cycle in the supplied
 * schema is reported rather than followed, because a cyclic current schema has
 * no defined recursive freshness and silently stopping would invent an answer.
 * @param {FreshnessInput} input
 * @returns {{freshness: Map<string, NodeFreshness>} | {error: JournalError}}
 */
function deriveFreshness(input) {
    const { selections, certificates, currentInputKeysOfNode } = input;
    /** @type {Map<string, NodeFreshness>} */
    const freshness = new Map();
    /** @type {Set<string>} */
    const inProgress = new Set();
    /**
     * @param {string} nodeKeyString
     * @returns {JournalError | undefined}
     */
    function resolve(nodeKeyString) {
        if (freshness.has(nodeKeyString)) {
            return undefined;
        }
        if (inProgress.has(nodeKeyString)) {
            return makeJournalProjectionError(
                "the current schema is cyclic at " + nodeKeyString,
                nodeKeyString
            );
        }
        inProgress.add(nodeKeyString);
        const selected = certificates.get(nodeKeyString);
        // `validInputs` is `edgeValid` applied to every current input, so the
        // lowering and the exported relation cannot drift apart.
        /** @type {Set<string>} */
        const validInputs = new Set();
        for (const inputKeyString of currentInputKeysOfNode(nodeKeyString)) {
            if (edgeValid(inputKeyString, nodeKeyString, selections, certificates)) {
                validInputs.add(inputKeyString);
            }
        }
        let fresh = false;
        if (isPresent(selections, nodeKeyString) && selected !== undefined) {
            const current = currentInputKeysOfNode(nodeKeyString);
            const completeBasis = selected.effectiveInputs.size === current.length;
            if (completeBasis && selected.coversValueInvalidations) {
                fresh = true;
                for (const inputKeyString of current) {
                    const failure = resolve(inputKeyString);
                    if (failure !== undefined) {
                        inProgress.delete(nodeKeyString);
                        return failure;
                    }
                    const inputFreshness = freshness.get(inputKeyString);
                    if (inputFreshness === undefined || !inputFreshness.fresh) {
                        fresh = false;
                        break;
                    }
                }
            }
        }
        inProgress.delete(nodeKeyString);
        freshness.set(nodeKeyString, new NodeFreshnessClass(fresh, validInputs, selected));
        return undefined;
    }
    for (const nodeKeyString of input.nodeKeyStrings) {
        const failure = resolve(nodeKeyString);
        if (failure !== undefined) {
            return { error: failure };
        }
    }
    return { freshness };
}

/**
 * The current occurrence of every present node, as the lowering writes it.
 * @typedef {object} ProjectedOccurrence
 * @property {string} nodeKeyString
 * @property {import("../types").NodeKey} nodeKey
 * @property {import("../types").JournalRecordId} valueId
 * @property {import("../../database/types").NodeIdentifier} nodeIdentifier
 * @property {import("../../database/types").ComputedValue} payload
 * @property {string} createdAt
 * @property {string} modifiedAt
 * @property {boolean} fresh
 * @property {Set<string>} validInputs
 */

/**
 * The projection of one retained journal, ready to lower into graph storage.
 *
 * The properties this class carries are:
 * - `occurrences` names every present semantic node exactly once, in ascending
 *   canonical order, with the occurrence fields the selected `ValueEvent` carries
 *   and the derived freshness and validity edges;
 * - `lastNodeIndex` is the reconstructed allocator watermark of the local writer;
 * - the physical `NodeIdentifier`s of the present nodes are pairwise distinct, so
 *   the lowering's `identifiers_keys_map` is bijective over present keys.
 *
 * The proof of those properties is guaranteed by:
 * - `projectRetainedJournal(options)`: runs the streaming head, invalidation and
 *   certificate passes, rejects a non-dependency-closed selected head set, and
 *   rejects two present nodes which select one incompatible physical identifier
 *   before it builds this class.
 *
 * - `selfProofReadyNodes` names every present node whose own proof is ready,
 *   which the specification's committed invariant requires to be fresh.
 *
 * The proof of those properties is guaranteed by:
 * - `projectRetainedJournal(options)`: runs the streaming head, invalidation and
 *   certificate passes, rejects a non-dependency-closed selected head set, and
 *   rejects two present nodes which select one incompatible physical identifier
 *   before it builds this class.
 *
 * - `selfProofReadyNodes` names every present node whose own proof is ready,
 *   which the specification's committed invariant requires to be fresh.
 * - `unmarkedPropagatedStaleness` names the nodes which break that invariant:
 *   self-proof-ready yet not fresh, with staleness attributable to a direct
 *   input's freshness. The specification requires a supported *committed*
 *   projection to have none of these, and makes the guarantee procedural rather
 *   than a theorem, so the oracle reports them instead of assuming them away.
 *
 * The proof of those properties is guaranteed by:
 * - `projectRetainedJournal(options)`: runs the streaming head, invalidation and
 *   certificate passes, rejects a non-dependency-closed selected head set, and
 *   rejects two present nodes which select one incompatible physical identifier
 *   before it builds this class.
 *
 * @param {ReadonlyArray<ProjectedOccurrence>} occurrences
 * @param {Map<string, NodeFreshness>} freshness
 * @param {number} lastNodeIndex
 * @param {import("../types").JournalAuthor} localWriter
 * @param {Set<string>} selfProofReadyNodes
 * @param {Set<string>} unmarkedPropagatedStaleness
 */
class ProjectionClass {
    /**
     * @param {ReadonlyArray<ProjectedOccurrence>} occurrences
     * @param {Map<string, NodeFreshness>} freshness
     * @param {number} lastNodeIndex
     * @param {import("../types").JournalAuthor} localWriter
     * @param {Set<string>} selfProofReadyNodes
     * @param {Set<string>} unmarkedPropagatedStaleness
     */
    constructor(
        occurrences,
        freshness,
        lastNodeIndex,
        localWriter,
        selfProofReadyNodes,
        unmarkedPropagatedStaleness
    ) {
        this.occurrences = occurrences;
        this.freshness = freshness;
        this.lastNodeIndex = lastNodeIndex;
        this.localWriter = localWriter;
        this.selfProofReadyNodes = selfProofReadyNodes;
        this.unmarkedPropagatedStaleness = unmarkedPropagatedStaleness;
    }
}

/** @typedef {ProjectionClass} Projection */

/**
 * @param {unknown} value
 * @returns {value is Projection}
 */
function isProjection(value) {
    return value instanceof ProjectionClass;
}

/**
 * The current occurrence fields the lowering writes, taken from the selected
 * `ValueEvent` without normalising either timestamp.
 *
 * An occurrence with `createdAt` after `modifiedAt` is a valid occurrence, so
 * the two instants are carried exactly as the record holds them and are not
 * ordered against each other here.
 * @param {import("../records").ValueEvent} valueEvent
 * @param {string} nodeKeyString
 * @param {NodeFreshness} nodeFreshness
 * @returns {ProjectedOccurrence}
 */
function occurrenceOf(valueEvent, nodeKeyString, nodeFreshness) {
    return {
        nodeKeyString,
        nodeKey: valueEvent.node,
        valueId: valueEvent.id,
        nodeIdentifier: valueEvent.nodeIdentifier,
        payload: valueEvent.payload,
        createdAt: valueEvent.createdAt,
        modifiedAt: valueEvent.modifiedAt,
        fresh: nodeFreshness.fresh,
        validInputs: nodeFreshness.validInputs,
    };
}

/**
 * Are the selected heads dependency-closed under the current schema?
 *
 * Every supported committed projection satisfies "present K implies every
 * current input of K is present". A retained union may violate this while
 * synchronization is still constructing an inactive target, and such a union is
 * not publishable, so the oracle reports it rather than projecting it.
 * @param {Map<string, import("./heads").HeadSelection>} selections
 * @param {(nodeKeyString: string) => ReadonlyArray<string>} currentInputKeysOfNode
 * @returns {JournalError | undefined}
 */
function validateDependencyClosure(selections, currentInputKeysOfNode) {
    const names = [...selections.keys()].sort();
    for (const nodeKeyString of names) {
        if (!isPresent(selections, nodeKeyString)) {
            continue;
        }
        for (const inputKeyString of currentInputKeysOfNode(nodeKeyString)) {
            if (!isPresent(selections, inputKeyString)) {
                return makeJournalProjectionError(
                    "the selected head is present but its direct input is absent, so the " +
                        "selected head set is not dependency-closed",
                    nodeKeyString
                );
            }
        }
    }
    return undefined;
}

/**
 * Do two present nodes ever select one physical `NodeIdentifier`?
 *
 * The allocation contract establishes identifier uniqueness, so a collision means
 * unsupported or corrupt current state. Replay does not resolve it by scanning
 * historical occurrences, and it does not resolve it at all.
 * @param {Map<string, import("./heads").HeadSelection>} selections
 * @returns {JournalError | undefined}
 */
function validateNodeIdentifierDistinctness(selections) {
    /** @type {Map<string, string>} */
    const byIdentifier = new Map();
    for (const nodeKeyString of [...selections.keys()].sort()) {
        const selection = selections.get(nodeKeyString);
        if (selection === undefined) {
            continue;
        }
        const winner = selection.winner;
        if (winner === undefined || !isValueEvent(winner)) {
            continue;
        }
        const identifier = nodeIdentifierToString(winner.nodeIdentifier);
        const incumbent = byIdentifier.get(identifier);
        if (incumbent !== undefined) {
            return makeJournalProjectionError(
                "present nodes " +
                    incumbent +
                    " and " +
                    nodeKeyString +
                    " select the same physical node identifier " +
                    identifier,
                nodeKeyString
            );
        }
        byIdentifier.set(identifier, nodeKeyString);
    }
    return undefined;
}

module.exports = {
    isNodeFreshness,
    NodeFreshnessClass,
    ProjectionClass,
    deriveFreshness,
    edgeValid,
    isProjection,
    occurrenceOf,
    selfProofReady,
    validateDependencyClosure,
    validateNodeIdentifierDistinctness,
};
