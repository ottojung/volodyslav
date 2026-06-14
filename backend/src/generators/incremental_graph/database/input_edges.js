/**
 * Shared utilities for input-edge normalization and comparison.
 *
 * Input edges are the deduplicated, sorted structural dependency lists
 * stored in the persisted "inputs" records.
 */

const { nodeIdentifierToString } = require("./types");

/**
 * Create a dependency accumulator for the materialized dependency record.
 * @param {import('./types').NodeIdentifier[]} inputIdentifiers
 * @returns {import('./types').NodeIdentifier[]}
 */
function normalizeInputEdges(inputIdentifiers) {
    /** @type {Set<string>} */
    const seen = new Set();
    /** @type {import('./types').NodeIdentifier[]} */
    const edges = [];
    for (const id of inputIdentifiers) {
        const idStr = nodeIdentifierToString(id);
        if (!seen.has(idStr)) {
            seen.add(idStr);
            edges.push(id);
        }
    }
    return edges;
}

/**
 * Compare two NodeIdentifier arrays for element-wise equality.
 * @param {import('./types').NodeIdentifier[]} a
 * @param {import('./types').NodeIdentifier[]} b
 * @returns {boolean}
 */
function arraysOfNodeIdentifiersEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        const aId = a[i];
        const bId = b[i];
        if (aId === undefined || bId === undefined) return false;
        if (nodeIdentifierToString(aId) !== nodeIdentifierToString(bId)) return false;
    }
    return true;
}

module.exports = {
    normalizeInputEdges,
    arraysOfNodeIdentifiersEqual,
};
