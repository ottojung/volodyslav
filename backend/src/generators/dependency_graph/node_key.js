/**
 * Node key handling - keys are JSON objects, not expression strings.
 * 
 * A node key is an object with:
 * - head: string (the node name)
 * - args: Array<DatabaseValue> (the bound values)
 * 
 * For patterns (schema definitions), args contain variable names as strings.
 * For concrete nodes (actual instances), args contain DatabaseValue objects.
 */

/** @typedef {import('./types').DatabaseValue} DatabaseValue */

/**
 * A node key object.
 * @typedef {object} NodeKey
 * @property {string} head - The node name/head
 * @property {Array<DatabaseValue>} args - The arguments (bindings for concrete nodes)
 */

/**
 * Creates a canonical string representation of a node key for storage.
 * Uses JSON serialization for stable, deterministic keys.
 * @param {NodeKey} key
 * @returns {string}
 */
function serializeNodeKey(key) {
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
 * @param {Record<string, DatabaseValue>} bindings - Variable bindings
 * @returns {NodeKey}
 */
function createNodeKey(pattern, bindings) {
    const { parseExpr } = require("./expr");
    const expr = parseExpr(pattern);
    
    if (expr.kind === "atom") {
        return { head: expr.name, args: [] };
    }
    
    // For call expressions, substitute variables with their bindings
    const args = expr.args.map(arg => {
        if (arg.kind === "identifier") {
            const varName = arg.value;
            if (varName in bindings) {
                return bindings[varName];
            }
            throw new Error(`Variable '${varName}' not found in bindings`);
        }
        throw new Error(`Pattern should only contain identifiers, got ${arg.kind}`);
    });
    
    return { head: expr.name, args };
}

/**
 * Checks if a node key is concrete (no unbound variables).
 * Since we construct keys from bindings, they're always concrete.
 * @param {NodeKey} _key
 * @returns {boolean}
 */
function isConcreteKey(_key) {
    return true; // Keys created with createNodeKey are always concrete
}

module.exports = {
    serializeNodeKey,
    deserializeNodeKey,
    createNodeKey,
    isConcreteKey,
};
