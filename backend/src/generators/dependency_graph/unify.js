/**
 * Unification algorithm for matching concrete nodes against compiled patterns.
 */

const { parseExpr, renderExpr, renderArg } = require("./expr");
const { makeSchemaPatternNotAllowedError } = require("./errors");

/** @typedef {import('./types').CompiledNode} CompiledNode */
/** @typedef {import('./types').DatabaseValue} DatabaseValue */
/** @typedef {import('./expr').ParsedArg} ParsedArg */
/** @typedef {import('./expr').ParsedExpr} ParsedExpr */

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
 * Converts a ParsedArg to a DatabaseValue.
 * @param {ParsedArg} arg
 * @returns {DatabaseValue}
 */
function argToValue(arg) {
    if (arg.kind === "string") {
        return arg.value;
    } else if (arg.kind === "number") {
        return parseInt(arg.value, 10);
    }
    throw new Error(`Cannot convert ${arg.kind} to value`);
}

/**
 * Converts a DatabaseValue to a ParsedArg.
 * @param {DatabaseValue} value
 * @returns {ParsedArg}
 */
function valueToArg(value) {
    if (typeof value === "string") {
        return { kind: "string", value };
    } else if (typeof value === "number") {
        return { kind: "number", value: String(value) };
    }
    throw new Error(`Cannot convert value ${JSON.stringify(value)} to arg`);
}

/**
 * Attempts to match a concrete node expression with a compiled pattern.
 * Returns bindings if successful, or null if matching fails.
 *
 * @param {string} concreteKey - The concrete node key (must contain only constants, no variables)
 * @param {CompiledNode} compiledNode - The compiled node to match against
 * @returns {{ bindings: Record<string, DatabaseValue> } | null} Bindings if successful, null otherwise
 */
function matchConcrete(concreteKey, compiledNode) {
    // Validate that concrete key has no variables
    validateConcreteKey(concreteKey);
    
    const concreteExpr = parseExpr(concreteKey);

    // Must have same head
    if (concreteExpr.name !== compiledNode.head) {
        return null;
    }

    // Must have same arity
    if (concreteExpr.args.length !== compiledNode.arity) {
        return null;
    }

    // Match arguments and extract bindings
    /** @type {Record<string, DatabaseValue>} */
    const bindings = {};

    for (let i = 0; i < concreteExpr.args.length; i++) {
        const concreteArg = concreteExpr.args[i];
        const patternArg = compiledNode.outputExpr.args[i];

        if (!concreteArg || !patternArg) {
            return null;
        }

        if (patternArg.kind === "identifier") {
            // Variable in pattern - bind to concrete value
            const varName = patternArg.value;
            const value = argToValue(concreteArg);

            // Check for consistency if variable already bound
            if (varName in bindings) {
                // For consistent matching with repeated variables
                // DatabaseValue is either string or number, so we can use strict equality
                const existing = bindings[varName];
                if (typeof existing !== typeof value || existing !== value) {
                    return null;
                }
            } else {
                bindings[varName] = value;
            }
        } else {
            // Constant in pattern - must match exactly
            if (concreteArg.kind !== patternArg.kind || concreteArg.value !== patternArg.value) {
                return null;
            }
        }
    }

    return { bindings };
}

/**
 * Substitutes variables in an expression pattern with their bindings.
 * 
 * @param {string} pattern - The pattern (e.g., "photo(p)" or "event(x)")
 * @param {Record<string, DatabaseValue>} bindings - Variable bindings
 * @param {Set<string>} variables - Set of variable names in the pattern
 * @returns {string} The substituted expression (canonical form)
 */
function substitute(pattern, bindings, variables) {
    const expr = parseExpr(pattern);

    if (expr.kind === "atom") {
        // No substitution needed for atoms
        return pattern;
    }

    // Substitute each argument
    const substitutedArgs = expr.args.map(arg => {
        if (arg.kind === "identifier") {
            const varName = arg.value;
            if (varName in bindings) {
                return valueToArg(bindings[varName]);
            } else {
                // Variable not bound - keep as is (shouldn't happen if validation is correct)
                return arg;
            }
        } else {
            // Constant - keep as is
            return arg;
        }
    });

    const substitutedExpr = {
        kind: /** @type {const} */ ("call"),
        name: expr.name,
        args: substitutedArgs,
    };

    return renderExpr(substitutedExpr);
}

module.exports = {
    matchConcrete,
    substitute,
    validateConcreteKey,
};
