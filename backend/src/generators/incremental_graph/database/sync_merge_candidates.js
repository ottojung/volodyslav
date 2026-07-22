const { compareIsoTimestamps } = require('./sync_merge_timestamps');
const { nodeIdentifierToString } = require('./types');

/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */

/**
 * The properties that this type carries are:
 * - The candidate identifies one materialized semantic node version by its
 *   persisted `modifiedAt` timestamp and its persisted `NodeIdentifier`.
 * - The candidate is sufficient for the merge-wide total order that selects a
 *   materialized version without consulting source roles or computed values.
 *
 * The proof of those properties is guaranteed by:
 * - This typedef cannot enforce the property by construction.
 * - Therefore every function that returns this type is part of the proof.
 * - The current return sites are:
 *   - `makeMaterializationCandidate(identifier, modifiedAt)`: satisfies the
 *     property because callers pass the identifier obtained from the semantic
 *     identifier lookup and the `modifiedAt` field obtained from the matching
 *     timestamp record for that identifier.
 *
 * Comparator equality means equal version identity because the comparator
 * returns zero only when both `modifiedAt` values compare chronologically equal
 * and both canonical `NodeIdentifier` strings are equal. The ordering is
 * independent of source roles because it reads only persisted candidate fields,
 * never labels such as local, host, keep, or take.
 *
 * @typedef {object} MaterializationCandidate
 * @property {NodeIdentifier} identifier
 * @property {string} modifiedAt
 */

/**
 * Create a materialization candidate for canonical merge comparison.
 * @param {NodeIdentifier} identifier
 * @param {string} modifiedAt
 * @returns {MaterializationCandidate}
 */
function makeMaterializationCandidate(identifier, modifiedAt) {
    return { identifier, modifiedAt };
}

/**
 * Compare materialized candidates by the canonical synchronization tuple:
 * `(modifiedAt, NodeIdentifier)`. Newer timestamps rank higher. When timestamps
 * are chronologically equal, lexicographically greater canonical identifier
 * strings rank higher using deterministic JavaScript code-unit ordering.
 *
 * @param {MaterializationCandidate} a
 * @param {MaterializationCandidate} b
 * @returns {number} Negative when `a` ranks below `b`, positive when `a` ranks
 *   above `b`, and zero only when both candidates are the same selected version.
 */
function compareMaterializationCandidates(a, b) {
    const timeComparison = compareIsoTimestamps(a.modifiedAt, b.modifiedAt);
    if (timeComparison !== 0) return timeComparison;

    const aIdentifier = nodeIdentifierToString(a.identifier);
    const bIdentifier = nodeIdentifierToString(b.identifier);
    if (aIdentifier < bIdentifier) return -1;
    if (aIdentifier > bIdentifier) return 1;
    return 0;
}

module.exports = {
    compareMaterializationCandidates,
    makeMaterializationCandidate,
};
