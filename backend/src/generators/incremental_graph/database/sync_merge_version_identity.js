/**
 * Source-version identity for incremental-graph merge.
 *
 * This module provides the canonical operation that answers whether a
 * source-side materialization represents the final selected semantic value
 * version for a given semantic node key. Complete version identity is the pair
 * `(modifiedAt, NodeIdentifier)`, represented here by selected-source identity
 * or exact-version equality precomputed by merge planning.
 */

const { nodeIdentifierToString } = require('./types');

/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */

/**
 * Check whether a source-side materialization represents the final selected
 * semantic value version for a given semantic key.
 *
 * True when:
 * 1. The source side is the actual selected source side and the source
 *    identifier is the actual selected source identifier; or
 * 2. Both replicas contain that semantic key with exact version identity:
 *    matching `modifiedAt` and matching canonical `NodeIdentifier`.
 *
 * @param {object} options
 * @param {'keep' | 'take'} options.side - The source side being queried
 *   ('keep' for local/target, 'take' for host).
 * @param {NodeIdentifier} options.sourceId - The source-side identifier.
 * @param {NodeKeyString} options.nodeKey - The semantic key.
 * @param {Map<NodeKeyString, 'keep' | 'take'>} options.selectedSideByKey
 * @param {Map<NodeKeyString, NodeIdentifier>} options.finalIdentifierForKey
 * @param {Set<NodeKeyString>} options.equalVersionKeys
 * @returns {boolean}
 */
function sourceRepresentsFinalVersion({ side, sourceId, nodeKey, selectedSideByKey, finalIdentifierForKey, equalVersionKeys = new Set() }) {
    const finalId = finalIdentifierForKey.get(nodeKey);
    if (finalId !== undefined && side === selectedSideByKey.get(nodeKey) && nodeIdentifierToString(sourceId) === nodeIdentifierToString(finalId)) return true;
    return finalId !== undefined
        && equalVersionKeys.has(nodeKey)
        && nodeIdentifierToString(sourceId) === nodeIdentifierToString(finalId);
}

module.exports = { sourceRepresentsFinalVersion };
