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

/**
 * Checks if two patterns can unify (i.e., there exists a concrete instantiation that matches both).
 * This respects repeated-variable constraints within each pattern.
 *
 * @param {import('./expr').ParsedExpr} pattern1Expr - First pattern expression
 * @param {Set<string>} vars1 - Variables in first pattern
 * @param {import('./expr').ParsedExpr} pattern2Expr - Second pattern expression
 * @param {Set<string>} vars2 - Variables in second pattern
 * @returns {boolean} True if patterns can overlap
 */
function patternsCanUnify(pattern1Expr, vars1, pattern2Expr, vars2) {
    // Must have same head and arity
    if (pattern1Expr.name !== pattern2Expr.name) {
        return false;
    }
    if (pattern1Expr.args.length !== pattern2Expr.args.length) {
        return false;
    }

    // Try to unify - track bindings for each pattern's variables
    /** @type {Record<string, string>} */
    const bindings1 = {}; // Maps pattern1 variables to unified values
    /** @type {Record<string, string>} */
    const bindings2 = {}; // Maps pattern2 variables to unified values

    for (let i = 0; i < pattern1Expr.args.length; i++) {
        const arg1 = pattern1Expr.args[i];
        const arg2 = pattern2Expr.args[i];

        if (arg1 === undefined || arg2 === undefined) {
            return false;
        }

        const isVar1 = vars1.has(arg1);
        const isVar2 = vars2.has(arg2);

        if (isVar1 && isVar2) {
            // Both are variables
            // Check consistency with existing bindings
            const bound1 = bindings1[arg1];
            const bound2 = bindings2[arg2];

            if (bound1 !== undefined && bound2 !== undefined) {
                // Both already bound - must match
                if (bound1 !== bound2) {
                    return false; // Conflict
                }
            } else if (bound1 !== undefined) {
                // arg1 already bound, bind arg2 to same value
                bindings2[arg2] = bound1;
            } else if (bound2 !== undefined) {
                // arg2 already bound, bind arg1 to same value
                bindings1[arg1] = bound2;
            } else {
                // Neither bound - create fresh binding
                // Use a synthetic value to represent this equivalence class
                const freshValue = `#unified_${i}`;
                bindings1[arg1] = freshValue;
                bindings2[arg2] = freshValue;
            }
        } else if (isVar1 && !isVar2) {
            // arg1 is variable, arg2 is constant
            const bound1 = bindings1[arg1];
            if (bound1 !== undefined && bound1 !== arg2) {
                return false; // Conflict
            }
            bindings1[arg1] = arg2;
        } else if (!isVar1 && isVar2) {
            // arg1 is constant, arg2 is variable
            const bound2 = bindings2[arg2];
            if (bound2 !== undefined && bound2 !== arg1) {
                return false; // Conflict
            }
            bindings2[arg2] = arg1;
        } else {
            // Both are constants - must match
            if (arg1 !== arg2) {
                return false; // Constants differ
            }
        }
    }

    // If we get here, unification succeeded
    return true;
}

module.exports = {
    unify,
    substitute,
    patternsCanUnify,
};
