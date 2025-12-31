/**
 * Unification algorithm for matching concrete nodes against schema patterns.
 */

const { parseExpr, canonicalize } = require("./expr");

/** @typedef {import('./schema').CompiledSchema} CompiledSchema */

/**
 * Attempts to unify a concrete node expression with a schema pattern.
 * Returns bindings if successful, or null if unification fails.
 *
 * @param {string} concreteKey - The concrete node key (already canonicalized)
 * @param {CompiledSchema} compiledSchema - The compiled schema to match against
 * @returns {{ bindings: Record<string, string> } | null} Bindings if successful, null otherwise
 */
function unify(concreteKey, compiledSchema) {
    const concreteExpr = parseExpr(concreteKey);

    // Must have same head
    if (concreteExpr.name !== compiledSchema.head) {
        return null;
    }

    // Must have same arity
    if (concreteExpr.args.length !== compiledSchema.arity) {
        return null;
    }

    const variables = new Set(compiledSchema.schema.variables);
    /** @type {Record<string, string>} */
    const bindings = {};

    // Try to unify each argument position
    for (let i = 0; i < compiledSchema.arity; i++) {
        const concreteArg = concreteExpr.args[i];
        const schemaArg = compiledSchema.outputExpr.args[i];
        
        if (concreteArg === undefined || schemaArg === undefined) {
            return null; // Arity mismatch
        }

        if (variables.has(schemaArg)) {
            // Schema arg is a variable - bind it
            if (schemaArg in bindings) {
                // Variable already bound - check consistency
                if (bindings[schemaArg] !== concreteArg) {
                    return null; // Inconsistent binding
                }
            } else {
                // New binding
                bindings[schemaArg] = concreteArg;
            }
        } else {
            // Schema arg is a constant - must match exactly
            if (schemaArg !== concreteArg) {
                return null; // Constant mismatch
            }
        }
    }

    return { bindings };
}

/**
 * Substitutes variables in an expression pattern with their bindings.
 *
 * @param {string} pattern - The pattern (e.g., "photo(p)")
 * @param {Record<string, string>} bindings - Variable bindings
 * @param {Set<string>} variables - Set of variable names
 * @returns {string} The instantiated pattern (canonicalized)
 */
function substitute(pattern, bindings, variables) {
    const expr = parseExpr(pattern);

    if (expr.kind === "const") {
        // Constants don't need substitution
        return expr.name;
    }

    // Substitute variables in arguments
    const substitutedArgs = expr.args.map((arg) => {
        if (variables.has(arg)) {
            if (!(arg in bindings)) {
                throw new Error(
                    `Variable '${arg}' not found in bindings when substituting '${pattern}'`
                );
            }
            return bindings[arg];
        }
        return arg; // Constants pass through
    });

    return canonicalize(`${expr.name}(${substitutedArgs.join(",")})`);
}

module.exports = {
    unify,
    substitute,
};
