/**
 * Source-version identity for incremental-graph merge.
 *
 * This module provides the canonical operation that answers whether a
 * source-side materialization represents the final selected semantic value
 * record for a given semantic node key. Only the selected source contributes
 * value provenance, dependency history, and validity proofs.
 */

const { nodeIdentifierToString } = require('./types');

/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */

/**
 * Check whether a source-side materialization represents the final selected
 * semantic value record for a given semantic key.
 *
 * @param {object} options
 * @param {'keep' | 'take'} options.side - The source side being queried.
 * @param {NodeIdentifier} options.sourceId - The source-side identifier.
 * @param {NodeKeyString} options.nodeKey - The semantic key.
 * @param {Map<NodeKeyString, 'keep' | 'take'>} options.selectedSideByKey
 * @param {Map<NodeKeyString, NodeIdentifier>} options.finalIdentifierForKey
 * @returns {boolean}
 */
function sourceRepresentsFinalVersion({ side, sourceId, nodeKey, selectedSideByKey, finalIdentifierForKey }) {
    const finalId = finalIdentifierForKey.get(nodeKey);
    return finalId !== undefined
        && side === selectedSideByKey.get(nodeKey)
        && nodeIdentifierToString(sourceId) === nodeIdentifierToString(finalId);
}

module.exports = { sourceRepresentsFinalVersion };
