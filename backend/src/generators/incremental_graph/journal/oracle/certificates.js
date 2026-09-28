/**
 * Certificate selection: which retained validation is current proof for a node.
 *
 * `incremental-graph-journal-replay.md` §Current validation candidates,
 * §Eligible certificate, §Effective basis match and §Certificate selection
 * define a candidate set, an eligibility predicate, a per-input effectiveness
 * predicate and a three-key lexicographic maximum over the eligible candidates.
 *
 * Every one of those is evaluated per certificate, from that certificate and from
 * the invalidation summaries, so the oracle streams the retained validations and
 * keeps one winner per node. Two consequences are worth stating because they are
 * what makes the pass streaming rather than merely written as a loop:
 *
 * - `currentInputs(K)` comes from the current schema, so the number of basis
 *   entries the oracle reads per candidate is bounded by the schema's arity
 *   rather than by the certificate's own history.
 * - `effectiveBasisMatchCount` is a count over that same bounded input set, so
 *   the first ordering key is computable without a second pass.
 *
 * The ordering is exactly the specified one: effective basis strength, then
 * `coversValueInvalidations` with true above false, then `authorityCompare`.
 * Replay never combines basis entries from different validations, so a losing
 * certificate's entries are read and discarded, never merged into the winner.
 */

const { isValidateEvent } = require("../records");
const { nodeKeyToCanonicalString } = require("../basis");
const { authorityCompare } = require("../ordering");
const { journalRecordIdToString } = require("../types");
const { streamWithReport } = require("./scan");
const { summaryIsCovered } = require("./invalidations");

/** @typedef {import("../errors").AnyJournalError} JournalError */
/** @typedef {import("./record_source").JournalSource} JournalSource */
/** @typedef {import("./invalidations").InvalidationSummary} InvalidationSummary */

/**
 * The properties that this class carries are:
 * - `certificate` is a retained `ValidateEvent` for this node naming this node's
 *   selected occurrence, whose input-key set is exactly the current input set of
 *   the node, which no uncovered node invalidation excludes, and which is the
 *   greatest such certificate under the specified three-key order.
 * - `effectiveInputs` is exactly the set of current direct inputs whose basis
 *   entry names the current `ValueId` of that input and which no uncovered proof
 *   barrier for that input suppresses.
 * - `coversValueInvalidations` is true exactly when no value-scoped invalidation
 *   naming this occurrence is outside this certificate's context.
 *
 * The proof of those properties is guaranteed by:
 * - `selectCertificates(source, options)`: visits every retained record, applies
 *   `isEligibleCertificate` to each `ValidateEvent` naming a selected
 *   occurrence, and replaces the stored winner only when the arriving eligible
 *   candidate is greater under `compareCertificates`, so the stored winner is
 *   the specified maximum over the specified eligible set. `effectiveInputs` and
 *   `coversValueInvalidations` are derived from the winning certificate in the
 *   same visit which stored it, so they describe the stored certificate and no
 *   other.
 *
 * @param {import("../records").ValidateEvent} certificate
 * @param {Set<string>} effectiveInputs
 * @param {boolean} coversValueInvalidations
 */
class SelectedCertificateClass {
    /**
     * @param {import("../records").ValidateEvent} certificate
     * @param {Set<string>} effectiveInputs
     * @param {boolean} coversValueInvalidations
     */
    constructor(certificate, effectiveInputs, coversValueInvalidations) {
        this.certificate = certificate;
        this.effectiveInputs = effectiveInputs;
        this.coversValueInvalidations = coversValueInvalidations;
    }
}

/** @typedef {SelectedCertificateClass} SelectedCertificate */

/**
 * @param {unknown} value
 * @returns {value is SelectedCertificate}
 */
function isSelectedCertificate(value) {
    return value instanceof SelectedCertificateClass;
}

/** @typedef {import("../reference_rules").CurrentInputKeysOfNode} CurrentInputKeysOfNode */

/**
 * The current occurrences the certificate passes are about.
 * @typedef {object} SelectedOccurrences
 * @property {(nodeKeyString: string) => import("../types").JournalRecordId | undefined} valueIdOf
 * @property {(name: string) => import("../types").JournalAuthor | undefined} authorOf
 */

/**
 * The inputs of `nodeKeyString` in the current schema, as a set of canonical
 * identities. A node outside the current schema has no current inputs, which is
 * what makes a retained occurrence of a removed node family history rather than
 * an unsatisfiable certificate.
 * @param {CurrentInputKeysOfNode} currentInputKeysOfNode
 * @param {string} nodeKeyString
 * @returns {Set<string>}
 */
function currentInputSet(currentInputKeysOfNode, nodeKeyString) {
    const current = currentInputKeysOfNode(nodeKeyString);
    return new Set(current === undefined ? [] : current);
}

/**
 * The current inputs this candidate actually proves, given the invalidation
 * summaries and the current occurrence of each input.
 *
 * A value-scoped invalidation does not remove incoming proof, and a proof barrier
 * removes exactly the one edge it names, so effectiveness is a per-input
 * conjunction and never a whole-certificate verdict.
 * @param {import("../records").ValidateEvent} candidate
 * @param {ReadonlyMap<string, InvalidationSummary>} summaries
 * @param {SelectedOccurrences} occurrences
 * @param {CurrentInputKeysOfNode} currentInputKeysOfNode
 * @returns {Set<string>}
 */
function effectiveInputsOf(candidate, summaries, occurrences, currentInputKeysOfNode) {
    const nodeKeyString = nodeKeyToCanonicalString(candidate.node);
    const current = currentInputSet(currentInputKeysOfNode, nodeKeyString);
    /** @type {Map<string, import("../types").JournalRecordId | "unknown">} */
    const claimed = new Map();
    for (const entry of candidate.basis) {
        claimed.set(nodeKeyToCanonicalString(entry.input), entry.value);
    }
    const effective = new Set();
    for (const inputKeyString of current) {
        const value = claimed.get(inputKeyString);
        if (value === undefined || value === "unknown") {
            continue;
        }
        const inputValueId = occurrences.valueIdOf(inputKeyString);
        if (inputValueId === undefined) {
            continue;
        }
        if (journalRecordIdToString(value) !== journalRecordIdToString(inputValueId)) {
            continue;
        }
        const summary = summaries.get(nodeKeyString);
        const barrier = summary === undefined ? undefined : summary.proofScoped.get(inputKeyString);
        if (barrier !== undefined && !summaryIsCovered(barrier, candidate.context, occurrences.authorOf)) {
            continue;
        }
        effective.add(inputKeyString);
    }
    return effective;
}

/**
 * Is this candidate an eligible certificate for its node's selected occurrence?
 * @param {import("../records").ValidateEvent} candidate
 * @param {ReadonlyMap<string, InvalidationSummary>} summaries
 * @param {SelectedOccurrences} occurrences
 * @param {CurrentInputKeysOfNode} currentInputKeysOfNode
 * @returns {boolean}
 */
function isEligibleCertificate(candidate, summaries, occurrences, currentInputKeysOfNode) {
    const nodeKeyString = nodeKeyToCanonicalString(candidate.node);
    const selectedValueId = occurrences.valueIdOf(nodeKeyString);
    if (selectedValueId === undefined) {
        return false;
    }
    if (journalRecordIdToString(candidate.value) !== journalRecordIdToString(selectedValueId)) {
        return false;
    }
    const current = currentInputSet(currentInputKeysOfNode, nodeKeyString);
    const declared = candidate.basis.map((entry) => nodeKeyToCanonicalString(entry.input));
    if (new Set(declared).size !== declared.length) {
        return false;
    }
    if (declared.length !== current.size) {
        return false;
    }
    for (const inputKeyString of declared) {
        if (!current.has(inputKeyString)) {
            return false;
        }
    }
    const summary = summaries.get(nodeKeyString);
    if (summary !== undefined && !summaryIsCovered(summary.nodeScoped, candidate.context, occurrences.authorOf)) {
        return false;
    }
    return true;
}

/**
 * Does this eligible candidate causally cover every value-scoped invalidation of
 * its node's selected occurrence?
 * @param {import("../records").ValidateEvent} candidate
 * @param {ReadonlyMap<string, InvalidationSummary>} summaries
 * @param {SelectedOccurrences} occurrences
 * @returns {boolean}
 */
function coversValueInvalidations(candidate, summaries, occurrences) {
    const summary = summaries.get(nodeKeyToCanonicalString(candidate.node));
    if (summary === undefined) {
        return true;
    }
    return summaryIsCovered(summary.valueScoped, candidate.context, occurrences.authorOf);
}

/**
 * Is `challenger` the better certificate under the specified three-key order?
 *
 * `coversValueInvalidations` precedes authority, which is what makes a
 * certificate which causally observed a value-scoped invalidation of the current
 * occurrence beat a concurrent certificate with greater clock authority.
 * @param {SelectedCertificate} incumbent
 * @param {SelectedCertificate} challenger
 * @returns {boolean}
 */
function compareCertificates(incumbent, challenger) {
    if (challenger.effectiveInputs.size !== incumbent.effectiveInputs.size) {
        return challenger.effectiveInputs.size > incumbent.effectiveInputs.size;
    }
    const challengerCovers = challenger.coversValueInvalidations;
    const incumbentCovers = incumbent.coversValueInvalidations;
    if (challengerCovers !== incumbentCovers) {
        return challengerCovers;
    }
    return authorityCompare(challenger.certificate, incumbent.certificate) > 0;
}

/**
 * Select the current certificate of every present node.
 * @param {JournalSource} source
 * @param {object} options
 * @param {SelectedOccurrences} options.occurrences
 * @param {ReadonlyMap<string, InvalidationSummary>} options.summaries
 * @param {CurrentInputKeysOfNode} options.currentInputKeysOfNode
 * @returns {{certificates: Map<string, SelectedCertificate>} | {error: JournalError}}
 */
function selectCertificates(source, options) {
    const { occurrences, summaries, currentInputKeysOfNode } = options;
    /** @type {Map<string, SelectedCertificate>} */
    const certificates = new Map();
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
        const challenger = new SelectedCertificateClass(
            record,
            effectiveInputsOf(record, summaries, occurrences, currentInputKeysOfNode),
            coversValueInvalidations(record, summaries, occurrences)
        );
        const incumbent = certificates.get(nodeKeyString);
        if (incumbent === undefined || compareCertificates(incumbent, challenger)) {
            certificates.set(nodeKeyString, challenger);
        }
        return undefined;
    });
    if (failure !== undefined) {
        return { error: failure };
    }
    return { certificates };
}

module.exports = {
    SelectedCertificateClass,
    compareCertificates,
    coversValueInvalidations,
    currentInputSet,
    effectiveInputsOf,
    isEligibleCertificate,
    isSelectedCertificate,
    selectCertificates,
};
