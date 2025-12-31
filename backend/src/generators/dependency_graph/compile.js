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

    // Extract variables from the definition
    // Variables are explicitly provided in def.variables for pattern nodes
    const declaredVars = new Set(def.variables || []);

    // Determine which output args are variables
    const outputVars = new Set();
    if (outputExpr.kind === "call") {
        for (const arg of outputExpr.args) {
            if (declaredVars.has(arg)) {
                outputVars.add(arg);
            }
        }
    }

    // Validate that all input variables are in the output
    for (const inputCanonical of inputsCanonical) {
        const inputExpr = parseExpr(inputCanonical);
        if (inputExpr.kind === "call") {
            for (const arg of inputExpr.args) {
                if (declaredVars.has(arg) && !outputVars.has(arg)) {
                    throw makeInvalidSchemaError(
                        `Input variable '${arg}' is not present in output pattern`,
                        def.output
                    );
                }
            }
        }
    }

    // Determine if this is a pattern node
    const isPattern = declaredVars.size > 0;

    return {
        outputCanonical,
        inputsCanonical,
        outputExpr,
        head,
        arity,
        variables: outputVars,
        computor: def.computor,
        isPattern,
    };
}

module.exports = {
    compileNode,
};
