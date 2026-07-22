/**
 * Source-version identity for incremental-graph merge.
 *
 * This module provides the canonical operation that answers whether a
 * source-side materialization represents the final selected semantic value
 * version for a given semantic node key. The selected byte source identifies
 * which replica supplied the final stored bytes. Source-version identity
 * determines whether source-side dependency histories and validity proofs
 * apply to the final selected semantic version.
 *
 * FIXME(#1521): Equal modifiedAt is temporarily treated as identity of one
 * replicated semantic value version. Independent recomputations can collide
 * at the same timestamp. Replace this approximation with journal-backed
 * stable value-version identity.
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
 * 2. Both replicas contain that semantic key and their modifiedAt values
 *    compare equal under the synchronization timestamp comparison (the
 *    temporary approximation tracked by #1521).
 *
 * @param {object} options
 * @param {'keep' | 'take'} options.side - The source side being queried
 *   ('keep' for local/target, 'take' for host).
 * @param {NodeIdentifier} options.sourceId - The source-side identifier.
 * @param {NodeKeyString} options.nodeKey - The semantic key.
 * @param {Map<NodeKeyString, 'keep' | 'take'>} options.selectedSideByKey
 * @param {Map<NodeKeyString, NodeIdentifier>} options.finalIdentifierForKey
 * @param {Set<NodeKeyString>} options.equalTimestampKeys
 * @returns {boolean}
 */
function sourceRepresentsFinalVersion({ side, sourceId, nodeKey, selectedSideByKey, finalIdentifierForKey, equalTimestampKeys }) {
    const finalId = finalIdentifierForKey.get(nodeKey);
    if (finalId !== undefined && side === selectedSideByKey.get(nodeKey) && nodeIdentifierToString(sourceId) === nodeIdentifierToString(finalId)) return true;
    return equalTimestampKeys.has(nodeKey);
}

module.exports = { sourceRepresentsFinalVersion };
