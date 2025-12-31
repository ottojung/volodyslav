/**
 * Unification algorithm for matching concrete nodes against compiled patterns.
 */

const { parseExpr, renderExpr } = require("./expr");
const { argToConstValue } = require("./compiled_node");
const { makeSchemaPatternNotAllowedError } = require("./errors");

/** @typedef {import('./types').CompiledNode} CompiledNode */
/** @typedef {import('./types').ConstValue} ConstValue */
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
 * Checks if two constant values are equal.
 * @param {ConstValue} a
 * @param {ConstValue} b
 * @returns {boolean}
 */
function constValuesEqual(a, b) {
    if (a.kind !== b.kind) {
        return false;
    }
    return a.value === b.value;
}

/**
 * Renders a ConstValue back to a ParsedArg for substitution.
 * @param {ConstValue} constValue
 * @returns {ParsedArg}
 */
function constValueToArg(constValue) {
    if (constValue.kind === "string") {
        return { kind: "string", value: /** @type {string} */(constValue.value) };
    } else if (constValue.kind === "nat") {
        return { kind: "number", value: String(constValue.value) };
    }
    throw new Error(`Unknown const value kind: ${/** @type {any} */(constValue).kind}`);
}

/**
 * Attempts to match a concrete node expression with a compiled pattern.
 * Returns typed bindings if successful, or null if matching fails.
 *
 * @param {string} concreteKey - The concrete node key (must be fully concrete)
 * @param {CompiledNode} compiledNode - The compiled node to match against
 * @returns {{ bindings: Record<string, ConstValue> } | null} Typed bindings if successful, null otherwise
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

    /** @type {Record<string, ConstValue>} */
    const bindings = {};

    // Try to match each argument position
    for (let i = 0; i < compiledNode.arity; i++) {
        const concreteArg = concreteExpr.args[i];
        const patternArg = compiledNode.outputExpr.args[i];
        
        if (concreteArg === undefined || patternArg === undefined) {
            return null; // Arity mismatch
        }

        if (patternArg.kind === "identifier") {
            // Pattern arg is a variable - bind it
            const varName = patternArg.value;
            const concreteValue = argToConstValue(concreteArg);
            
            if (concreteValue === null) {
                // This shouldn't happen as we validated concrete key
                return null;
            }
            
            if (varName in bindings) {
                // Variable already bound - check consistency
                const existingBinding = bindings[varName];
                if (existingBinding && !constValuesEqual(existingBinding, concreteValue)) {
                    return null; // Inconsistent binding (e.g., pair(x,x) with different values)
                }
            } else {
                // New binding
                bindings[varName] = concreteValue;
            }
        } else {
            // Pattern arg is a constant - must match exactly
            const patternValue = argToConstValue(patternArg);
            const concreteValue = argToConstValue(concreteArg);
            
            if (patternValue === null || concreteValue === null) {
                return null;
            }
            
            if (!constValuesEqual(patternValue, concreteValue)) {
                return null; // Constant mismatch
            }
        }
    }

    return { bindings };
}

/**
 * Substitutes variables in an expression pattern with their typed bindings.
 *
 * @param {string} pattern - The pattern (e.g., "photo(p)")
 * @param {Record<string, ConstValue>} bindings - Typed variable bindings
 * @param {Set<string>} variables - Set of variable names
 * @returns {string} The instantiated pattern (canonical form)
 */
function substitute(pattern, bindings, variables) {
    const expr = parseExpr(pattern);

    if (expr.kind === "const") {
        // Constants don't need substitution
        return expr.name;
    }

    // Substitute variables in arguments
    const substitutedArgs = expr.args.map((arg) => {
        if (arg.kind === "identifier" && variables.has(arg.value)) {
            // It's a variable - substitute with binding
            if (!(arg.value in bindings)) {
                throw new Error(
                    `Variable '${arg.value}' not found in bindings when substituting '${pattern}'`
                );
            }
            const constValue = bindings[arg.value];
            if (!constValue) {
                throw new Error(
                    `Variable '${arg.value}' has undefined binding when substituting '${pattern}'`
                );
            }
            return constValueToArg(constValue);
        }
        // It's a constant - pass through
        return arg;
    });

    // Render back to canonical string
    return renderExpr({
        kind: "call",
        name: expr.name,
        args: substitutedArgs,
    });
}

module.exports = {
    matchConcrete,
    substitute,
    validateConcreteKey,
};
