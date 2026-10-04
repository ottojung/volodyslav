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
 */

/** @typedef {import('../journal/errors').AnyJournalError} JournalError */
/** @typedef {import('../journal/basis').ValidationBasis} ValidationBasis */
/** @typedef {import('../journal/records').ValidateEvent} ValidateEvent */
/** @typedef {import('../journal/types').JournalRecordId} JournalRecordId */
/** @typedef {import('../journal/types').NodeKey} NodeKey */
/** @typedef {import('../journal/oracle/invalidations').InvalidationSummary} InvalidationSummary */
/** @typedef {import('../journal/oracle/record_source').JournalSource} JournalSource */
/** @typedef {import('../journal/oracle/projection').Projection} Projection */
/** @typedef {import('./pass1').ResetValueId} ResetValueId */
/** @typedef {import('./authoring').ResetProofBarrierRequest} ResetProofBarrierRequest */
/** @typedef {import('./authoring').ResetValidationRequest} ResetValidationRequest */

const {
    effectiveInputsOf,
    isEligibleCertificate,
    isValidateEvent,
    makeJournalProjectionError,
    makeValidationBasisEntry,
    nodeKeyToCanonicalString,
    sortValidationBasis,
    streamWithReport,
} = require("../journal");

/**
 * The selected occurrences a certificate's inputs are compared against.
 * @typedef {object} ResetOccurrences
 * @property {(nodeKeyString: string) => JournalRecordId | undefined} valueIdOf
 * @property {(name: string) => import('../journal/types').JournalAuthor | undefined} authorOf
 */

/**
 * The union of incoming edges any eligible retained certificate can currently
 * prove for a node's selected occurrence.
 *
 * One streaming pass keeps one set per node, bounded by the current schema's
 * arity rather than by the certificate history, and adds each eligible candidate's
 * effective inputs to it. This is the union replay's maintenance summary expresses
 * as `eligibleProofEdgeCount(K,V,D) > 0`, read here in its streaming form: a
 * losing certificate's edges count exactly as much as a winning certificate's,
 * which is the whole reason the specification asks for a count rather than a flag.
 *
 * @param {object} request
 * @param {JournalSource} request.source
 * @param {ResetOccurrences} request.occurrences
 * @param {ReadonlyMap<string, InvalidationSummary>} request.summaries
 * @param {(nodeKeyString: string) => ReadonlyArray<string>} request.currentInputKeysOfNode
 * @returns {{unions: Map<string, Set<string>>} | {error: JournalError}}
 */
function eligibleEffectiveProofUnion(request) {
    const { source, occurrences, summaries, currentInputKeysOfNode } = request;
    /** @type {Map<string, Set<string>>} */
    const unions = new Map();
    const failure = streamWithReport(source, (record) => {
        if (!isValidateEvent(record)) {
            return undefined;
        }
        const nodeKeyString = nodeKeyToCanonicalString(record.node);
        if (occurrences.valueIdOf(nodeKeyString) === undefined) {
            return undefined;
        }
        if (!isEligibleCertificate(record, summaries, occurrences, currentInputKeysOfNode)) {
            return undefined;
        }
        const effective = effectiveInputsOf(record, summaries, occurrences, currentInputKeysOfNode);
        let union = unions.get(nodeKeyString);
        if (union === undefined) {
            union = new Set();
            unions.set(nodeKeyString, union);
        }
        for (const inputKeyString of effective) {
            union.add(inputKeyString);
        }
        return undefined;
    });
    if (failure !== undefined) {
        return { error: failure };
    }
    return { unions };
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
 * @property {Set<string>} validInputs
 * @property {boolean} fresh
 */

/**
 * Plan the proof-edge barriers the target does not want exposed.
 *
 * @param {object} plan
 * @param {ReadonlyArray<ResetTargetOccurrence>} plan.targetOccurrences - The
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
 * - `planTargetValidations(...)`: it compares the post-barrier selected
 *   certificate's derived `validInputs` with the target's validity edges and, for
 *   a target-fresh node, requires that the certificate covers its occurrence's
 *   value-scoped invalidations; a node which satisfies both keeps the certificate
 *   replay already selected and is absent from the result.
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
 * @param {ReadonlyArray<ResetTargetOccurrence>} plan.targetOccurrences
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
        if (
            freshness !== undefined &&
            freshness.certificate !== undefined &&
            sameEdgeSet(freshness.validInputs, occurrence.validInputs) &&
            (!occurrence.fresh || freshness.certificate.coversValueInvalidations)
        ) {
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