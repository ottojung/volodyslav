const { compareIsoTimestamps } = require('./sync_merge_timestamps');
const { compareNodeIdentifier } = require('./node_identifier');

/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */

/**
 * The properties that this type carries are:
 * - The candidate identifies one materialized source record by its persisted
 *   `modifiedAt` timestamp, its persisted `NodeIdentifier`, and the validated
 *   allocation fingerprint of the source replica containing the record.
 * - The candidate is sufficient for the merge-wide total order that selects a
 *   materialized record without consulting source roles or computed values.
 *
 * The proof of those properties is guaranteed by:
 * - This typedef cannot enforce the property by construction.
 * - Therefore every function that returns this type is part of the proof.
 * - The current return sites are:
 *   - `makeMaterializationCandidate(identifier, modifiedAt, sourceFingerprint)`:
 *     satisfies the property because callers pass the identifier obtained from
 *     the semantic identifier lookup, the `modifiedAt` field obtained from the
 *     matching timestamp record for that identifier, and the source replica
 *     fingerprint after `requireValidFingerprint(...)` accepts it.
 *
 * Comparator equality means equal source record identity because the comparator
 * returns zero only when `modifiedAt`, canonical `NodeIdentifier`, and validated
 * source fingerprint are all equal. Normal cross-host merge rejects equal source
 * fingerprints before planning, so opposing source candidates cannot compare
 * equal. The ordering is independent of source roles because it reads only
 * persisted candidate fields, never labels such as local, host, keep, or take.
 *
 * @typedef {object} MaterializationCandidate
 * @property {NodeIdentifier} identifier
 * @property {string} modifiedAt
 * @property {string} sourceFingerprint
 */

/**
 * Create a materialization candidate for canonical merge comparison.
 * @param {NodeIdentifier} identifier
 * @param {string} modifiedAt
 * @param {string} sourceFingerprint
 * @returns {MaterializationCandidate}
 */
function makeMaterializationCandidate(identifier, modifiedAt, sourceFingerprint) {
    return { identifier, modifiedAt, sourceFingerprint };
}

/**
 * Compare materialized candidates by the canonical synchronization tuple:
 * `(modifiedAt, NodeIdentifier, sourceFingerprint)`. Newer timestamps rank
 * higher. When timestamps are chronologically equal, greater canonical
 * identifiers rank higher. When both are equal, lexicographically greater source
 * fingerprints rank higher using deterministic JavaScript code-unit ordering.
 *
 * @param {MaterializationCandidate} a
 * @param {MaterializationCandidate} b
 * @returns {number} Negative when `a` ranks below `b`, positive when `a` ranks
 *   above `b`, and zero only when both candidates are the same source record.
 */
function compareMaterializationCandidates(a, b) {
    const timeComparison = compareIsoTimestamps(a.modifiedAt, b.modifiedAt);
    if (timeComparison !== 0) return timeComparison;

    const identifierComparison = compareNodeIdentifier(a.identifier, b.identifier);
    if (identifierComparison !== 0) return identifierComparison;

    if (a.sourceFingerprint < b.sourceFingerprint) return -1;
    if (a.sourceFingerprint > b.sourceFingerprint) return 1;
    return 0;
}

module.exports = {
    compareMaterializationCandidates,
    makeMaterializationCandidate,
};
