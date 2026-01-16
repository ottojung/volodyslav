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
const { stringToNodeKeyString, nodeNameToString, stringToNodeName, nodeKeyStringToString } = require("./database");

/** @typedef {import('./types').ConstValue} ConstValue */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */
/** @typedef {import('./types').NodeName} NodeName */
/** @typedef {import('./types').SchemaPattern} SchemaPattern */

/**
 * A node key object for concrete nodes.
 * @typedef {object} NodeKey
 * @property {NodeName} head - The node name/head
 * @property {Array<ConstValue>} args - The arguments (bound values - ConstValue types only)
 */

/**
 * Creates a canonical string representation of a node key for storage.
 * Order of keys of the serialized object matters! This is by design.
 * @param {NodeKey} key
 * @returns {NodeKeyString}
 */
function serializeNodeKey(key) {
    const headStr = nodeNameToString(key.head);
    const serialized = JSON.stringify({ head: headStr, args: key.args });
    return stringToNodeKeyString(serialized);
}

/**
 * Parses a serialized node key back to an object.
 * @param {NodeKeyString} serialized
 * @returns {NodeKey}
 */
function deserializeNodeKey(serialized) {
    const str = nodeKeyStringToString(serialized);
    const parsed = JSON.parse(str);
    return { head: stringToNodeName(parsed.head), args: parsed.args };
}

/**
 * Creates a node key from a pattern string and positional bindings.
 * Pattern like "event(e)" with bindings [{id: 5}] becomes {head: "event", args: [{id: 5}]}
 * Variable names are ignored - only position matters.
 * @param {SchemaPattern} pattern - Pattern string like "event(e)" or "all_events"
 * @param {Array<ConstValue>} bindings - Positional bindings array (ConstValue types only)
 * @returns {NodeKey}
 */
function createNodeKeyFromPattern(pattern, bindings) {
    const { parseExpr } = require("./expr");
    const expr = parseExpr(pattern);
    const head = expr.name;
    
    if (expr.kind === "atom") {
        if (bindings.length !== 0) {
            throw makeArityMismatchError(head, 0, bindings.length);
        }
        return { head, args: [] };
    }
    
    // For call expressions, use positional bindings
    // The arity must match the bindings array length
    if (expr.args.length !== bindings.length) {
        throw makeArityMismatchError(head, expr.args.length, bindings.length);
    }
    
    // Simply use the bindings array as args (variable names are ignored)
    return { head, args: bindings };
}

module.exports = {
    serializeNodeKey,
    deserializeNodeKey,
    createNodeKeyFromPattern,
};
