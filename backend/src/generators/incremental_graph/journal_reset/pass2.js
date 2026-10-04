/**
 * Pass 2: target validity and proof.
 *
 * `incremental-graph-journal-reset.md` §Pass 2 is where reset is *weakening*
 * proof, and the whole point of the pass is that replay's certificate preference
 * makes a later, weaker certificate insufficient on its own:
 *
 * - replay picks a certificate by effective basis match first and authority
 *   second, so appending a certificate with more `"unknown"` entries does not by
 *   itself remove validity an older certificate still supplies. Reset therefore
 *   authors a barrier for every unwanted edge **any eligible retained certificate**
 *   could expose, which is `eligibleEffectiveProofUnion_P1(K) - TargetValid(K)`;
 * - a barrier is occurrence-scoped and names one input edge, so independent reset
 *   and migration operations on one `ValueId` compose by accumulating the edges
 *   each removed, and no unrelated basis entry of that certificate is touched;
 * - a certificate is authored only when replay does not already yield exactly the
 *   target edges. Proof *additions* need no barrier, because the later stronger
 *   certificate wins on effective basis match by itself.
 *
 * The union is read at the fixed post-value-repair cut, before any barrier of this
 * reset is authored. Weakening one certificate therefore cannot reveal an edge
 * from a previously losing certificate, so one pass over the difference is
 * complete and no iterative barrier-discovery loop exists.
 *
 * The union is read from the counted proof summary, not from the journal:
 * `incremental-graph-journal-storage.md` §Change-bounded proof summary requires
 * `eligibleProofEdgeCount` to be incrementally maintained derived state and
 * forbids reset from folding retained certificate/invalidation history to obtain
 * it, so this module never receives a `JournalSource`.
 */

/** @typedef {import('../journal/errors').AnyJournalError} JournalError */
/** @typedef {import('../journal/basis').ValidationBasis} ValidationBasis */
/** @typedef {import('../journal/records').ValidateEvent} ValidateEvent */
/** @typedef {import('../journal/types').JournalRecordId} JournalRecordId */
/** @typedef {import('../journal/types').NodeKey} NodeKey */
/** @typedef {import('./proof_summary').ProofSummary} ProofSummary */
/** @typedef {import('../journal/oracle/projection').Projection} Projection */
/** @typedef {import('./pass1').ResetValueId} ResetValueId */
/** @typedef {import('./authoring').ResetProofBarrierRequest} ResetProofBarrierRequest */
/** @typedef {import('./authoring').ResetValidationRequest} ResetValidationRequest */

const {
    journalRecordIdToString,
    makeJournalProjectionError,
    makeValidationBasisEntry,
    sortValidationBasis,
} = require("../journal");
const { eligibleProofEdgeUnion } = require("./proof_summary");

/**
 * The selected occurrences a certificate's inputs are compared against.
 * @typedef {object} ResetOccurrences
 * @property {(nodeKeyString: string) => JournalRecordId | undefined} valueIdOf
 * @property {(name: string) => import('../journal/types').JournalAuthor | undefined} authorOf
 */

/**
 * The union of incoming edges any eligible retained certificate can currently
 * prove for each target occurrence, read from the counted proof summary.
 *
 * `incremental-graph-journal-reset.md` §Pass 2 defines
 * `eligibleEffectiveProofUnion_P1(K)` as the edges whose
 * `eligibleProofEdgeCount_P1(K, resetValueId(K), D)` is positive, and
 * `incremental-graph-journal-storage.md` §Change-bounded proof summary states that
 * count is the incrementally maintained index representation of exactly that union.
 * This function performs the read, so it never consults a retained record: the
 * summary is what the caller maintained, and a losing certificate's edges are
 * counted in it just as a winning certificate's are.
 *
 * @param {object} request
 * @param {ProofSummary} request.summary - The proof summary at the
 *   post-value-repair cut.
 * @param {Iterable<ResetTargetOccurrence>} request.targetOccurrences - The
 *   target-present occurrences Pass 1 settled on.
 * @param {(name: string) => import('../journal/types').JournalAuthor | undefined} request.authorOf
 * @returns {Map<string, Set<string>>}
 */
function eligibleEffectiveProofUnion(request) {
    const { summary, targetOccurrences, authorOf } = request;
    /** @type {Map<string, Set<string>>} */
    const unions = new Map();
    for (const occurrence of targetOccurrences) {
        unions.set(
            occurrence.nodeKeyString,
            eligibleProofEdgeUnion({
                summary,
                nodeKeyString: occurrence.nodeKeyString,
                valueId: journalRecordIdToString(occurrence.valueId),
                authorOf,
            })
        );
    }
    return unions;
}

/**
 * The properties that this class carries are:
 * - `barriers` names exactly `eligibleEffectiveProofUnion_P1(K) - TargetValid(K)`
 *   for every target-present node of the reset domain, as an occurrence-scoped
 *   proof barrier naming the retained occurrence Pass 1 settled on.
 *
 * The proof of those properties is guaranteed by:
 * - `planProofBarriers(...)`: it walks the target-present domain in ascending
 *   canonical order, and for each node emits one request per element of the set
 *   difference `unions.get(K) - TargetValid(K)`, so a node whose eligible
 *   certificates expose no unwanted edge contributes no barrier and a node whose
 *   eligible certificate exposes a wanted edge contributes none for that edge.
 *
 * @param {ReadonlyArray<ResetProofBarrierRequest>} barriers
 */
class ProofBarriersClass {
    /** @param {ReadonlyArray<ResetProofBarrierRequest>} barriers */
    constructor(barriers) {
        this.barriers = barriers;
    }
}

/** @typedef {ProofBarriersClass} ProofBarriers */

/**
 * @param {unknown} value
 * @returns {value is ProofBarriers}
 */
function isProofBarriers(value) {
    return value instanceof ProofBarriersClass;
}

/**
 * @typedef {object} ResetTargetOccurrence
 * @property {string} nodeKeyString
 * @property {NodeKey} nodeKey
 * @property {ResetValueId} valueId
 * @property {import("../database/types").NodeIdentifier} nodeIdentifier
 * @property {import("../database/types").ComputedValue} payload
 * @property {string} createdAt
 * @property {string} modifiedAt
 * @property {Set<string>} validInputs
 * @property {boolean} fresh
 */

/**
 * Plan the proof-edge barriers the target does not want exposed.
 *
 * @param {object} plan
 * @param {Iterable<ResetTargetOccurrence>} plan.targetOccurrences - The
 *   target-present occurrences of the reset domain, in ascending canonical order.
 * @param {Map<string, Set<string>>} plan.unions - `eligibleEffectiveProofUnion` at
 *   the fixed post-value-repair cut.
 * @param {(nodeKeyString: string) => NodeKey | undefined} plan.nodeKeyOf
 * @returns {ProofBarriers | {error: JournalError}}
 */
function planProofBarriers(plan) {
    const { targetOccurrences, unions, nodeKeyOf } = plan;
    /** @type {ResetProofBarrierRequest[]} */
    const barriers = [];
    for (const occurrence of targetOccurrences) {
        const union = unions.get(occurrence.nodeKeyString);
        if (union === undefined) {
            continue;
        }
        for (const inputKeyString of [...union].sort()) {
            if (occurrence.validInputs.has(inputKeyString)) {
                continue;
            }
            const inputNodeKey = nodeKeyOf(inputKeyString);
            if (inputNodeKey === undefined) {
                return { error: makeUnknownInputError(occurrence.nodeKeyString, inputKeyString) };
            }
            barriers.push({
                kind: "proof-barrier",
                node: occurrence.nodeKey,
                value: occurrence.valueId,
                input: inputNodeKey,
            });
        }
    }
    return new ProofBarriersClass(barriers);
}

/**
 * The properties that this class carries are:
 * - `requests` names exactly the target-present nodes whose replay state at the
 *   post-barrier cut does not already yield exactly `TargetValid(K)` with the
 *   causal coverage the target freshness requires, each with a basis of one
 *   canonical-order entry per current direct input.
 *
 * The proof of those properties is guaranteed by:
 * - `planTargetValidations(...)`: it compares the post-barrier cut's derived
 *   `validInputs` with the target's validity edges and, for a target-fresh node,
 *   requires a selected certificate which covers its occurrence's value-scoped
 *   invalidations; a node which satisfies both keeps the state replay already
 *   yields and is absent from the result. A node with no certificate at all and no
 *   target edges already yields the target's empty edge set, so a target-stale node
 *   of that shape is left alone rather than given a gratuitous certificate which
 *   would make it self-proof-ready and therefore fresh against the target.
 *
 * @param {ReadonlyArray<ResetValidationRequest>} requests
 */
class TargetValidationsClass {
    /** @param {ReadonlyArray<ResetValidationRequest>} requests */
    constructor(requests) {
        this.requests = requests;
    }
}

/** @typedef {TargetValidationsClass} TargetValidations */

/**
 * @param {unknown} value
 * @returns {value is TargetValidations}
 */
function isTargetValidations(value) {
    return value instanceof TargetValidationsClass;
}

/**
 * Do two validity edge sets name exactly the same incoming edges?
 *
 * @param {ReadonlySet<string>} left
 * @param {ReadonlySet<string>} right
 * @returns {boolean}
 */
function sameEdgeSet(left, right) {
    if (left.size !== right.size) {
        return false;
    }
    for (const edge of left) {
        if (!right.has(edge)) {
            return false;
        }
    }
    return true;
}

/**
 * Plan the target certificates reset must author.
 *
 * The basis entry for an input is `resetValueId(D)` exactly when the target
 * contains the semantic validity edge `D -> K`, and `"unknown"` otherwise. Because
 * every authored validation is causally later than the barriers of this reset, an
 * all-`"unknown"` basis represents zero incoming target validity, and no older
 * full certificate can reintroduce a barriered edge.
 *
 * @param {object} plan
 * @param {Projection} plan.postBarrier - The projection at the post-barrier cut.
 * @param {Iterable<ResetTargetOccurrence>} plan.targetOccurrences
 * @param {(nodeKeyString: string) => ResetValueId | undefined} plan.resetValueIdOf
 * @param {(nodeKeyString: string) => NodeKey | undefined} plan.nodeKeyOf
 * @param {(nodeKeyString: string) => ReadonlyArray<string>} plan.currentInputKeysOfNode
 * @returns {TargetValidations | {error: JournalError}}
 */
function planTargetValidations(plan) {
    const { postBarrier, targetOccurrences, resetValueIdOf, nodeKeyOf, currentInputKeysOfNode } = plan;
    /** @type {ResetValidationRequest[]} */
    const requests = [];
    for (const occurrence of targetOccurrences) {
        const freshness = postBarrier.freshness.get(occurrence.nodeKeyString);
        const yieldsTargetEdges =
            freshness !== undefined &&
            sameEdgeSet(freshness.validInputs, occurrence.validInputs);
        const coversTargetFreshness =
            !occurrence.fresh ||
            (freshness !== undefined &&
                freshness.certificate !== undefined &&
                freshness.certificate.coversValueInvalidations);
        if (yieldsTargetEdges && coversTargetFreshness) {
            continue;
        }
        /** @type {ValidationBasis} */
        const basis = [];
        for (const inputKeyString of currentInputKeysOfNode(occurrence.nodeKeyString)) {
            const inputNodeKey = nodeKeyOf(inputKeyString);
            if (inputNodeKey === undefined) {
                return {
                    error: makeUnknownInputError(occurrence.nodeKeyString, inputKeyString),
                };
            }
            if (!occurrence.validInputs.has(inputKeyString)) {
                basis.push(makeValidationBasisEntry(inputNodeKey, "unknown"));
                continue;
            }
            const inputValueId = resetValueIdOf(inputKeyString);
            if (inputValueId === undefined) {
                return {
                    error: makeUnknownInputError(occurrence.nodeKeyString, inputKeyString),
                };
            }
            basis.push(makeValidationBasisEntry(inputNodeKey, inputValueId));
        }
        requests.push({
            kind: "validate",
            node: occurrence.nodeKey,
            value: occurrence.valueId,
            basis: sortValidationBasis(basis),
        });
    }
    return new TargetValidationsClass(requests);
}

/**
 * A target validity edge names an input whose occurrence this reset did not settle.
 *
 * @param {string} nodeKeyString
 * @param {string} inputKeyString
 * @returns {JournalError}
 */
function makeUnknownInputError(nodeKeyString, inputKeyString) {
    return makeJournalProjectionError(
        "the target validity edge " + inputKeyString + " -> " + nodeKeyString +
            " names an input occurrence the reset target does not settle",
        nodeKeyString
    );
}

module.exports = {
    ProofBarriersClass,
    TargetValidationsClass,
    eligibleEffectiveProofUnion,
    isProofBarriers,
    isTargetValidations,
    planProofBarriers,
    planTargetValidations,
    sameEdgeSet,
};