/**
 * Node key handling - stores node identities as JSON objects.
 * 
 * A concrete node key is: {head: string, args: Array<ConstValue>}
 * This provides clean serialization for any JSON-serializable binding values.
 * 
 * Example:
 * - Pattern: "event(e)" with bindings [{id: 5, time: "today"}]
 * - Concrete key: '{"head":"event","args":[{"id":5,"time":"today"}]}'
 * 
 * Benefits:
 * - Makes serialization/deserialization straightforward
 * - Works naturally with any JSON-serializable binding values
 * - No mixing of expression syntax with embedded JSON
 */

const { makeArityMismatchError } = require("./errors");

/** @typedef {import('./types').ConstValue} ConstValue */
/** @typedef {string} NodeKeyString */

/**
 * A node key object for concrete nodes.
 * @typedef {object} NodeKey
 * @property {string} head - The node name/head
 * @property {Array<ConstValue>} args - The arguments (bound values - ConstValue types only)
 */

/**
 * Creates a canonical string representation of a node key for storage.
 * Uses JSON serialization for stable, deterministic keys.
 * @param {NodeKey} key
 * @returns {NodeKeyString}
 */
function serializeNodeKey(key) {
    // Stable JSON serialization
    const serialized = JSON.stringify({ head: key.head, args: key.args });
    return serialized;
}

/**
 * Parses a serialized node key back to an object.
 * @param {NodeKeyString} serialized
 * @returns {NodeKey}
 */
function deserializeNodeKey(serialized) {
    return JSON.parse(serialized);
}

/**
 * Creates a node key from a pattern string and positional bindings.
 * Pattern like "event(e)" with bindings [{id: 5}] becomes {head: "event", args: [{id: 5}]}
 * Variable names are ignored - only position matters.
 * @param {string} pattern - Pattern string like "event(e)" or "all_events"
 * @param {Array<ConstValue>} bindings - Positional bindings array (ConstValue types only)
 * @returns {NodeKey}
 */
function createNodeKeyFromPattern(pattern, bindings) {
    const { parseExpr } = require("./expr");
    const expr = parseExpr(pattern);
    
    if (expr.kind === "atom") {
        return { head: expr.name, args: [] };
    }
    
    // For call expressions, use positional bindings
    // The arity must match the bindings array length
    if (expr.args.length !== bindings.length) {
        throw makeArityMismatchError(expr.name, expr.args.length, bindings.length);
    }
    
    // Simply use the bindings array as args (variable names are ignored)
    return { head: expr.name, args: bindings };
}

module.exports = {
    serializeNodeKey,
    deserializeNodeKey,
    createNodeKeyFromPattern,
};
