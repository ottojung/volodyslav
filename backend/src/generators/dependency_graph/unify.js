/**
 * Unification algorithm for matching concrete nodes against compiled patterns.
 */

const { parseExpr, renderExpr } = require("./expr");
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
 * Renders a ConstValue back to a ParsedArg for substitution.
 * @param {ConstValue} constValue
 * @returns {{kind: 'string' | 'number', value: string}}
 */
function constValueToArg(constValue) {
    if (constValue.type === "string") {
        return { kind: "string", value: constValue.value };
    } else if (constValue.type === "int") {
        return { kind: "number", value: String(constValue.value) };
    }
    throw new Error(`Unknown const value type: ${JSON.stringify(constValue)}`);
}

/**
 * Attempts to match a concrete node expression with a compiled pattern.
 * Since constants are no longer allowed, only atom-expressions can be concrete.
 * Returns empty bindings if successful, or null if matching fails.
 *
 * @param {string} concreteKey - The concrete node key (must be an atom-expression)
 * @param {CompiledNode} compiledNode - The compiled node to match against
 * @returns {{ bindings: Record<string, ConstValue> } | null} Empty bindings if successful, null otherwise
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
 * Substitutes variables in an expression pattern with their typed bindings.
 *
 * @param {string} pattern - The pattern (e.g., "photo(p)")
 * @param {Record<string, ConstValue>} bindings - Typed variable bindings
 * @param {Set<string>} variables - Set of variable names
 * @returns {string} The instantiated pattern (canonical form)
 */
function substitute(pattern, bindings, variables) {
    const expr = parseExpr(pattern);

    if (expr.kind === "atom") {
        // Atoms don't need substitution
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
        // @ts-ignore - substitutedArgs may contain string/number kind args from constValueToArg()
        args: substitutedArgs,
    });
}

module.exports = {
    matchConcrete,
    substitute,
    validateConcreteKey,
};
