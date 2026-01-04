/**
 * Unification algorithm for matching concrete nodes against compiled patterns.
 */

const { parseExpr } = require("./expr");
const { makeSchemaPatternNotAllowedError } = require("./errors");

/** @typedef {import('./types').CompiledNode} CompiledNode */
/** @typedef {import('./expr').ParsedArg} ParsedArg */

/**
 * Validates that a concrete key contains only constants (no variables).
 * @param {string} concreteKey
 * @throws {Error} If concreteKey contains variables (unquoted identifiers)
 */
function validateConcreteKey(concreteKey) {
    const expr = parseExpr(concreteKey);
    
    if (expr.kind === "call") {
        for (const arg of expr.args) {
            if (arg.kind === "identifier") {
                throw makeSchemaPatternNotAllowedError(concreteKey);
            }
        }
    }
}

/**
 * Attempts to match a concrete node expression with a compiled pattern.
 * Since constants are no longer allowed, only atom-expressions can be concrete.
 * Returns empty bindings if successful, or null if matching fails.
 *
 * @param {string} concreteKey - The concrete node key (must be an atom-expression)
 * @param {CompiledNode} compiledNode - The compiled node to match against
 * @returns {{ bindings: Record<string, never> } | null} Empty bindings if successful, null otherwise
 */
function matchConcrete(concreteKey, compiledNode) {
    // Validate that concrete key has no variables
    validateConcreteKey(concreteKey);
    
    const concreteExpr = parseExpr(concreteKey);

    // Must have same head
    if (concreteExpr.name !== compiledNode.head) {
        return null;
    }

    // Concrete expressions can only be atom-expressions (no arguments)
    // If the pattern has arguments, it can't match a concrete expression
    if (concreteExpr.args.length !== 0) {
        // This should not happen as validateConcreteKey ensures no variables
        // and we no longer allow constants, so any args would be invalid
        return null;
    }

    // Must have same arity (both should be 0 for atoms)
    if (compiledNode.arity !== 0) {
        return null;
    }

    // No bindings needed for atom-expressions
    return { bindings: {} };
}

/**
 * Substitutes variables in an expression pattern with their bindings.
 * Since constants are no longer supported and bindings are always empty,
 * this function now simply returns the pattern unchanged.
 *
 * @param {string} pattern - The pattern (e.g., "photo(p)" or "all_events")
 * @param {Record<string, never>} _bindings - Always empty since no constants
 * @param {Set<string>} _variables - Set of variable names (unused now)
 * @returns {string} The pattern unchanged (canonical form)
 */
function substitute(pattern, _bindings, _variables) {
    // Since constants are not allowed and bindings are always empty,
    // patterns cannot be instantiated with concrete values.
    // This function now just returns the pattern as-is.
    return pattern;
}

module.exports = {
    matchConcrete,
    substitute,
    validateConcreteKey,
};
