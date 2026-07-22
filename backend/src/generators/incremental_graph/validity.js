/**
 * Canonical runtime validity helper used by invalidation and recomputation.
 *
 * This module owns the operation of removing all incoming validity proofs for
 * a given node N. It is invoked during:
 * - Explicit invalidation (invalidate.js)
 * - Changed-value handling (recompute.js)
 */

/** @typedef {import('./graph_state').BatchBuilder} BatchBuilder */
/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */

/**
 * Remove N from valid[D] for each dependency D in inputEdges.
 * @param {BatchBuilder} batch
 * @param {NodeIdentifier} nId
 * @param {NodeIdentifier[]} inputEdges
 * @returns {void}
 */
function removeIncomingValidity(batch, nId, inputEdges) {
    for (const depId of inputEdges) {
        batch.valid.remove(depId, nId);
    }
}

module.exports = {
    removeIncomingValidity,
};
