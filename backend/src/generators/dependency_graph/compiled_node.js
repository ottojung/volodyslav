/**
 * Compiled node representation and compilation logic.
 */

const { parseExpr, renderExpr } = require("./expr");
const { makeInvalidSchemaError } = require("./errors");

/** @typedef {import('./expr').ParsedExpr} ParsedExpr */
/** @typedef {import('./expr').Term} Term */
/** @typedef {import('./expr').ConstValue} ConstValue */

/**
 * A node definition in the unified authoring format.
 * @typedef {Object} NodeDef
 * @property {string} output - The output pattern or exact key
 * @property {string[]} inputs - Input patterns/dependencies
 * @property {(inputs: Array<import('./types').DatabaseValue>, oldValue: import('./types').DatabaseValue | undefined, bindings: Record<string, ConstValue>) => import('./types').DatabaseValue | import('./unchanged').Unchanged} computor - Computation function
 */

/**
 * Compiled node with cached parsing results and metadata.
 * @typedef {Object} CompiledNode
 * @property {NodeDef} source - The original node definition
 * @property {ParsedExpr} outputExpr - Parsed output expression
 * @property {string} canonicalOutput - Canonical string form of output
 * @property {ParsedExpr[]} inputExprs - Parsed input expressions
 * @property {string[]} canonicalInputs - Canonical string forms of inputs
 * @property {string} head - The head/name of the output expression
 * @property {number} arity - Number of arguments in output
 * @property {boolean} isPattern - True if output contains variables
 * @property {Array<'var' | 'const'>} outputArgKinds - Kind of each output argument
 * @property {Array<ConstValue | null>} outputConstArgs - Constant values for const args, null for vars
 * @property {Map<string, number[]>} repeatedVarPositions - Map from var name to positions where it appears
 * @property {Set<string>} varsUsedInInputs - Variables used in any input pattern
 */

/**
 * Extracts variables from a term.
 * @param {Term} term
 * @param {Set<string>} variables - Set to add variables to
 */
function extractVariablesFromTerm(term, variables) {
    if (term.kind === "var") {
        variables.add(term.name);
    }
}

/**
 * Extracts variables from an expression.
 * @param {ParsedExpr} expr
 * @returns {Set<string>}
 */
function extractVariables(expr) {
    const variables = new Set();
    
    if (expr.kind === "call") {
        for (const arg of expr.args) {
            extractVariablesFromTerm(arg, variables);
        }
    }
    
    return variables;
}

/**
 * Analyzes output arguments to determine kinds and identify repeated variables.
 * @param {ParsedExpr} outputExpr
 * @returns {{
 *   outputArgKinds: Array<'var' | 'const'>,
 *   outputConstArgs: Array<ConstValue | null>,
 *   repeatedVarPositions: Map<string, number[]>,
 *   outputVars: Set<string>
 * }}
 */
function analyzeOutputArgs(outputExpr) {
    /** @type {Array<'var' | 'const'>} */
    const outputArgKinds = [];
    /** @type {Array<ConstValue | null>} */
    const outputConstArgs = [];
    /** @type {Map<string, number[]>} */
    const repeatedVarPositions = new Map();
    const outputVars = new Set();

    if (outputExpr.kind === "call") {
        for (let i = 0; i < outputExpr.args.length; i++) {
            const arg = outputExpr.args[i];
            if (arg === undefined) {
                throw new Error(`Unexpected undefined argument at position ${i}`);
            }

            if (arg.kind === "var") {
                outputArgKinds.push("var");
                outputConstArgs.push(null);
                outputVars.add(arg.name);

                // Track positions for repeated variable detection
                if (!repeatedVarPositions.has(arg.name)) {
                    repeatedVarPositions.set(arg.name, []);
                }
                const positions = repeatedVarPositions.get(arg.name);
                if (positions === undefined) {
                    throw new Error(`Unexpected undefined positions for ${arg.name}`);
                }
                positions.push(i);
            } else {
                // arg.kind === "const"
                outputArgKinds.push("const");
                if (!arg.value) {
                    throw new Error("Constant term must have a value");
                }
                outputConstArgs.push(arg.value);
            }
        }
    }

    // Filter repeated var positions to only include vars that appear more than once
    for (const [varName, positions] of repeatedVarPositions.entries()) {
        if (positions.length <= 1) {
            repeatedVarPositions.delete(varName);
        }
    }

    return { outputArgKinds, outputConstArgs, repeatedVarPositions, outputVars };
}

/**
 * Compiles a node definition into a CompiledNode.
 * @param {NodeDef} nodeDef
 * @returns {CompiledNode}
 * @throws {Error} If validation fails
 */
function compileNodeDef(nodeDef) {
    // Parse and canonicalize output
    const outputExpr = parseExpr(nodeDef.output);
    const canonicalOutput = renderExpr(outputExpr);

    // Parse and canonicalize inputs
    const inputExprs = nodeDef.inputs.map((input) => parseExpr(input));
    const canonicalInputs = inputExprs.map((expr) => renderExpr(expr));

    // Extract head and arity from output
    const head = outputExpr.name;
    const arity = outputExpr.args.length;

    // Analyze output arguments
    const { outputArgKinds, outputConstArgs, repeatedVarPositions, outputVars } =
        analyzeOutputArgs(outputExpr);

    // Determine if this is a pattern (has variables)
    const isPattern = outputVars.size > 0;

    // Collect variables used in inputs
    const varsUsedInInputs = new Set();
    for (const inputExpr of inputExprs) {
        const inputVars = extractVariables(inputExpr);
        for (const varName of inputVars) {
            varsUsedInInputs.add(varName);
        }
    }

    // Validate: all input variables must appear in output
    for (const inputVar of varsUsedInInputs) {
        if (!outputVars.has(inputVar)) {
            throw makeInvalidSchemaError(
                `Input variable '${inputVar}' is not present in output pattern`,
                canonicalOutput
            );
        }
    }

    return {
        source: nodeDef,
        outputExpr,
        canonicalOutput,
        inputExprs,
        canonicalInputs,
        head,
        arity,
        isPattern,
        outputArgKinds,
        outputConstArgs,
        repeatedVarPositions,
        varsUsedInInputs,
    };
}

module.exports = {
    compileNodeDef,
    extractVariables,
};
