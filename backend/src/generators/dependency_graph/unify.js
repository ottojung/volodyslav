/**
 * Unification algorithm for matching concrete nodes against compiled patterns.
 */

const { parseExpr, renderExpr } = require("./expr");
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
 * Converts a ParsedArg to a value that can be used as a binding.
 * For string args containing JSON, deserializes them back to objects.
 * @param {ParsedArg} arg
 * @returns {unknown}
 */
function argToValue(arg) {
    if (arg.kind === "string") {
        // Try to parse as JSON in case it's a serialized object
        try {
            const parsed = JSON.parse(arg.value);
            return parsed;
        } catch {
            // If not valid JSON, return as string (primitive binding)
            return arg.value;
        }
    } else if (arg.kind === "number") {
        // Return as number (primitive binding)
        return parseInt(arg.value, 10);
    }
    throw new Error(`Cannot convert ${arg.kind} to value`);
}

/**
 * Converts a value to a ParsedArg.
 * For objects, serializes them to JSON strings.
 * @param {unknown} value
 * @returns {ParsedArg}
 */
function valueToArg(value) {
    if (typeof value === "string") {
        return { kind: "string", value };
    } else if (typeof value === "number") {
        return { kind: "number", value: String(value) };
    } else if (typeof value === "object" && value !== null) {
        // Serialize objects to JSON strings
        return { kind: "string", value: JSON.stringify(value) };
    }
    throw new Error(`Cannot convert value ${JSON.stringify(value)} to arg`);
}

/**
 * Attempts to match a concrete node expression with a compiled pattern.
 * Returns bindings if successful, or null if matching fails.
 *
 * @param {string} concreteKey - The concrete node key (must contain only constants, no variables)
 * @param {CompiledNode} compiledNode - The compiled node to match against
 * @returns {{ bindings: Record<string, unknown> } | null} Bindings if successful, null otherwise
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
    /** @type {Record<string, unknown>} */
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
                // Use JSON comparison for any type of value
                const existing = bindings[varName];
                if (JSON.stringify(existing) !== JSON.stringify(value)) {
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
 * @param {Record<string, unknown>} bindings - Variable bindings
 * @param {Set<string>} _variables - Set of variable names in the pattern (unused)
 * @returns {string} The substituted expression (canonical form)
 */
function substitute(pattern, bindings, _variables) {
    const expr = parseExpr(pattern);

    if (expr.kind === "atom") {
        // No substitution needed for atoms
        return pattern;
    }

    // Substitute each argument
    const substitutedArgs = expr.args.map(arg => {
        if (arg.kind === "identifier") {
            const varName = arg.value;
            const binding = bindings[varName];
            if (binding !== undefined) {
                return valueToArg(binding);
            } else {
                // Variable not bound - keep as is (shouldn't happen if validation is correct)
                return arg;
            }
        } else {
            // Constant - keep as is
            return arg;
        }
    });

    /** @type {ParsedExpr} */
    const substitutedExpr = {
        kind: "call",
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
