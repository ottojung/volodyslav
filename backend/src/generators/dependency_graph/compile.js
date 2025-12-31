/**
 * Node compilation utilities - converts NodeDef to CompiledNode.
 */

const { parseExpr, canonicalize } = require("./expr");
const { makeInvalidSchemaError } = require("./errors");

/** @typedef {import('./types').NodeDef} NodeDef */
/** @typedef {import('./types').CompiledNode} CompiledNode */
/** @typedef {import('./expr').ParsedExpr} ParsedExpr */

/**
 * Compiles a node definition into the internal CompiledNode representation.
 * Canonicalizes outputs and inputs, parses expressions, and extracts variables.
 * Variables are automatically derived from the output expression arguments.
 *
 * @param {NodeDef} def - The node definition to compile
 * @returns {CompiledNode} The compiled node
 * @throws {Error} If the node definition is invalid
 */
function compileNode(def) {
    // Canonicalize output and inputs
    const outputCanonical = canonicalize(def.output);
    const inputsCanonical = def.inputs.map((input) => canonicalize(input));

    // Parse output expression
    const outputExpr = parseExpr(outputCanonical);
    const head = outputExpr.name;
    const arity = outputExpr.args.length;

    // Determine if this is a pattern node by checking computor signature
    // Pattern nodes have computors that accept 3 parameters (inputs, oldValue, bindings)
    const isPattern = def.computor.length >= 3;

    // Derive variables from output expression
    // For pattern nodes: all arguments in a call expression are variables
    // For concrete nodes: no variables
    const variables = new Set();
    if (isPattern && outputExpr.kind === "call") {
        for (const arg of outputExpr.args) {
            variables.add(arg);
        }
    }

    // If it's a pattern but has no variables in output, that's an error
    if (isPattern && variables.size === 0) {
        throw makeInvalidSchemaError(
            "Pattern node computor expects bindings but output has no variables",
            def.output
        );
    }

    return {
        outputCanonical,
        inputsCanonical,
        outputExpr,
        head,
        arity,
        variables,
        computor: def.computor,
        isPattern,
    };
}

module.exports = {
    compileNode,
};
