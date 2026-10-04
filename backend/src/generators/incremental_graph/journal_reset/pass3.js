/**
 * Pass 3: target freshness.
 *
 * `incremental-graph-journal-reset.md` §Pass 3 makes reset's freshness change
 * persistent history rather than a value replacement. Two rules drive the module:
 *
 * - a node the target holds stale needs a marker even when it is *recursively*
 *   stale at the reset cut, because recursive staleness through a stale input is
 *   not a persistent marker of its own. Without the marker, a later `Unchanged`
 *   revalidation of that input would make the node fresh even though the target's
 *   stored stale flag must stay stale until the node itself validates;
 * - a node which already has a persistent own-state reason for staleness — basis
 *   mismatch, an uncovered node invalidation, an effective proof-edge deficit, or
 *   an uncovered current-value invalidation — is `selfProofReady` false, and
 *   duplicating that reason would be a gratuitous record.
 *
 * So the marker is owed exactly for the target-stale nodes which are
 * self-proof-ready at this pass's cut.
 */

/** @typedef {import('../journal/errors').AnyJournalError} JournalError */
/** @typedef {import('../journal/types').JournalAuthor} JournalAuthor */
/** @typedef {import('../journal/oracle/projection').Projection} Projection */
/** @typedef {import('./pass1').ResetValueId} ResetValueId */
/** @typedef {import('./pass2').ResetTargetOccurrence} ResetTargetOccurrence */
/** @typedef {import('./authoring').ResetValueMarkerRequest} ResetValueMarkerRequest */

const { compareJournalSequence, journalSequenceAtFrontier } = require("../journal");

/**
 * The properties that this class carries are:
 * - `requests` names exactly the target-stale nodes of the reset domain whose own
 *   proof is ready at the reset cut, each naming the occurrence Pass 1 settled on.
 *
 * The proof of those properties is guaranteed by:
 * - `planFreshnessMarkers(...)`: it walks the target-present domain in ascending
 *   canonical order, skips every node the target holds fresh, skips every node
 *   which is not in `selfProofReadyNodes` of the cut's own projection, and skips a
 *   node whose selected occurrence already has an uncovered value-scoped
 *   invalidation, which is the persistent own-state reason the third rule of
 *   §Pass 3 names. Every remaining node is one for which the stored stale flag
 *   would otherwise be erasable by an unrelated upstream revalidation.
 *
 * @param {ReadonlyArray<ResetValueMarkerRequest>} requests
 */
class FreshnessMarkersClass {
    /** @param {ReadonlyArray<ResetValueMarkerRequest>} requests */
    constructor(requests) {
        this.requests = requests;
    }
}

/** @typedef {FreshnessMarkersClass} FreshnessMarkers */

/**
 * @param {unknown} value
 * @returns {value is FreshnessMarkers}
 */
function isFreshnessMarkers(value) {
    return value instanceof FreshnessMarkersClass;
}

/**
 * Plan the target-persistent-stale markers.
 *
 * @param {object} plan
 * @param {Projection} plan.postValidation - The projection at this pass's cut.
 * @param {ReadonlyArray<ResetTargetOccurrence>} plan.targetOccurrences
 * @param {(nodeKeyString: string, valueId: ResetValueId) => boolean} plan.hasUncoveredValueInvalidation
 * @returns {FreshnessMarkers}
 */
function planFreshnessMarkers(plan) {
    const { postValidation, targetOccurrences, hasUncoveredValueInvalidation } = plan;
    /** @type {ResetValueMarkerRequest[]} */
    const requests = [];
    for (const occurrence of targetOccurrences) {
        if (occurrence.fresh) {
            continue;
        }
        if (!postValidation.selfProofReadyNodes.has(occurrence.nodeKeyString)) {
            continue;
        }
        if (hasUncoveredValueInvalidation(occurrence.nodeKeyString, occurrence.valueId)) {
            continue;
        }
        requests.push({
            kind: "value-marker",
            node: occurrence.nodeKey,
            value: occurrence.valueId,
        });
    }
    return new FreshnessMarkersClass(requests);
}

/**
 * Does the retained history already hold a value-scoped invalidation of this
 * occurrence which the selected certificate does not observe?
 *
 * The summary is per node and per selected occurrence, so a question about one
 * occurrence cannot be answered by another's invalidations. This is a comparison
 * of two derived values the cut already produced, not a scan of invalidation
 * history: the summary is the per-writer maximum the replay pass maintains.
 *
 * @param {ReadonlyMap<string, import('../journal/oracle/invalidations').InvalidationSummary>} summaries
 * @param {import('../journal/oracle/certificates').SelectedCertificate | undefined} certificate
 * @param {string} nodeKeyString
 * @param {(name: string) => JournalAuthor | undefined} authorOf
 * @returns {boolean}
 */
function hasUncoveredValueInvalidationOf(summaries, certificate, nodeKeyString, authorOf) {
    const summary = summaries.get(nodeKeyString);
    if (summary === undefined || summary.valueScoped.size === 0) {
        return false;
    }
    if (certificate === undefined) {
        return true;
    }
    const context = certificate.certificate.context;
    for (const entry of summary.valueScoped) {
        const author = authorOf(entry[0]);
        if (author === undefined) {
            throw new Error("an invalidation summary names a writer the source does not hold");
        }
        if (compareJournalSequence(journalSequenceAtFrontier(context, author), entry[1]) < 0) {
            return true;
        }
    }
    return false;
}

module.exports = {
    FreshnessMarkersClass,
    hasUncoveredValueInvalidationOf,
    isFreshnessMarkers,
    planFreshnessMarkers,
};