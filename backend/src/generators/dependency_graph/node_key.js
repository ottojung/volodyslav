/**
 * Node key handling - stores node identities as JSON objects.
 * 
 * A concrete node key is: {head: string, args: Array<unknown>}
 * This is simpler than expression strings with embedded JSON.
 */

/** @typedef {import('./types').DatabaseValue} DatabaseValue */

/**
 * A node key object for concrete nodes.
 * @typedef {object} NodeKey
 * @property {string} head - The node name/head
 * @property {Array<unknown>} args - The arguments (bound values - can be any JSON value)
 */

/**
 * Creates a canonical string representation of a node key for storage.
 * Uses JSON serialization for stable, deterministic keys.
 * @param {NodeKey} key
 * @returns {string}
 */
function serializeNodeKey(key) {
    // Stable JSON serialization
    return JSON.stringify({ head: key.head, args: key.args });
}

/**
 * Parses a serialized node key back to an object.
 * @param {string} serialized
 * @returns {NodeKey}
 */
function deserializeNodeKey(serialized) {
    return JSON.parse(serialized);
}

/**
 * Creates a node key from a pattern string and bindings.
 * Pattern like "event(e)" with bindings {e: {id: 5}} becomes {head: "event", args: [{id: 5}]}
 * @param {string} pattern - Pattern string like "event(e)" or "all_events"
 * @param {Record<string, unknown>} bindings - Variable bindings (can be any JSON-serializable value)
 * @returns {NodeKey}
 */
function createNodeKeyFromPattern(pattern, bindings) {
    const { parseExpr } = require("./expr");
    const expr = parseExpr(pattern);
    
    if (expr.kind === "atom") {
        return { head: expr.name, args: [] };
    }
    
    // For call expressions, substitute variables with their bindings
    const args = expr.args.map(arg => {
        if (arg.kind === "identifier") {
            const varName = arg.value;
            const binding = bindings[varName];
            if (binding !== undefined) {
                return binding;
            }
            throw new Error(`Variable '${varName}' not found in bindings`);
        }
        throw new Error(`Pattern should only contain identifiers, got ${arg.kind}`);
    });
    
    return { head: expr.name, args };
}

module.exports = {
    serializeNodeKey,
    deserializeNodeKey,
    createNodeKeyFromPattern,
};
