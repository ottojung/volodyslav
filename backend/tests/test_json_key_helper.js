/**
 * Test helper for converting node names to JSON key format.
 * Used by tests that need to assert on concrete node keys in storage.
 */

const { createNodeKeyFromPattern, serializeNodeKey } = require("../src/generators/dependency_graph/node_key");
const { canonicalize } = require("../src/generators/dependency_graph/expr");

/**
 * Converts a node name to its JSON key format.
 * Helper for tests that need to work with concrete node keys.
 * @param {string} nodeName - Node name like "input1" or "derived(x)"
 * @param {Record<string, unknown>} [bindings={}] - Optional bindings
 * @returns {string} JSON key
 */
function toJsonKey(nodeName, bindings = {}) {
    const canonical = canonicalize(nodeName);
    const nodeKey = createNodeKeyFromPattern(canonical, bindings);
    return serializeNodeKey(nodeKey);
}

/**
 * Checks if a string is a JSON key (not foolproof, but good enough for tests).
 * @param {string} key
 * @returns {boolean}
 */
function isJsonKey(key) {
    if (!key.startsWith('{')) {
        return false;
    }
    try {
        const parsed = JSON.parse(key);
        return parsed && typeof parsed === 'object' && 'head' in parsed && 'args' in parsed;
    } catch {
        return false;
    }
}

module.exports = {
    toJsonKey,
    isJsonKey,
};
