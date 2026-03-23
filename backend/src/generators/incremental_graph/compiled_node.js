/**
 * Compilation of node definitions into CompiledNode with cached metadata.
 */

const { parseExpr, renderExpr } = require("./expr");
const { stringToSchemaPattern } = require("./database");
const {
    makeInvalidSchemaError,
} = require("./errors");
const {
    patternsCanOverlap,
    validateNoOverlap,
    validateAcyclic,
    validateSingleArityPerHead,
    validateInputArities,
    validateNodeDef,
} = require("./compiled_node_validation");

/** @typedef {import('./types').NodeDef} NodeDef */
/** @typedef {import('./types').CompiledNode} CompiledNode */
/** @typedef {import('./types').ConstValue} ConstValue */
/** @typedef {import('./types').NodeName} NodeName */
/** @typedef {import('./expr').ParsedExpr} ParsedExpr */
/** @typedef {import('./expr').ParsedArg} ParsedArg */

/**
 * Extracts variable names from a parsed expression.
 * Only identifiers in arguments are variables (strings and numbers are constants).
 * @param {ParsedExpr} expr
 * @returns {Set<string>}
 */
function extractVariables(expr) {
    /** @type {Set<string>} */
    const vars = new Set();

    if (expr.kind === "call") {
        for (const arg of expr.args) {
            // Only identifiers are variables
            if (arg.kind === "identifier") {
                vars.add(arg.value);
            }
        }
    }

    return vars;
}

/**
 * Finds positions where each variable appears in the output arguments.
 * Used for detecting repeated variables (e.g., pair(x,x)).
 * @param {ParsedExpr} outputExpr
 * @returns {Map<string, number[]>}
 */
function findRepeatedVarPositions(outputExpr) {
    /** @type {Map<string, number[]>} */
    const positions = new Map();

    if (outputExpr.kind === "call") {
        for (let i = 0; i < outputExpr.args.length; i++) {
            const arg = outputExpr.args[i];
            if (arg === undefined) continue;

            if (arg.kind === "identifier") {
                const varName = arg.value;
                if (!positions.has(varName)) {
                    positions.set(varName, []);
                }
                const posList = positions.get(varName);
                if (posList) {
                    posList.push(i);
                }
            }
        }
    }

    // Filter to only include variables that appear more than once
    const repeated = new Map();
    for (const [varName, posList] of positions.entries()) {
        if (posList.length > 1) {
            repeated.set(varName, posList);
        }
    }

    return repeated;
}

/**
 * Validates that an expression has no duplicate variable names.
 * @param {ParsedExpr} expr
 * @param {string} exprStr - For error messages
 */
function validateNoDuplicateVariables(expr, exprStr) {
    if (expr.kind !== "call") {
        return; // Atoms have no variables
    }

    const seen = new Set();
    for (const arg of expr.args) {
        if (arg.kind === "identifier") {
            const varName = arg.value;
            if (seen.has(varName)) {
                throw makeInvalidSchemaError(
                    `Duplicate variable '${varName}' in expression`,
                    exprStr,
                );
            }
            seen.add(varName);
        }
    }
}

/**
 * Validates that all variables used in inputs appear in the output.
 * This is the variable coverage rule.
 * @param {ParsedExpr} outputExpr
 * @param {ParsedExpr[]} inputExprs
 * @param {string} outputStr - For error messages
 */
function validateVariableCoverage(outputExpr, inputExprs, outputStr) {
    const outputVars = extractVariables(outputExpr);
    const inputVars = new Set();

    for (const inputExpr of inputExprs) {
        const vars = extractVariables(inputExpr);
        for (const v of vars) {
            inputVars.add(v);
        }
    }

    // Check that all input variables are in output variables
    for (const inputVar of inputVars) {
        if (!outputVars.has(inputVar)) {
            throw makeInvalidSchemaError(
                `Input variable '${inputVar}' is not present in output pattern`,
                outputStr,
            );
        }
    }
}

/**
 * Compiles a node definition into a CompiledNode with all metadata cached.
 * Accepts an optional index (compatible with Array.prototype.map callback signature)
 * so that structural validation errors can report the entry's position.
 * @param {NodeDef} nodeDef
 * @param {number} [index]
 * @returns {CompiledNode}
 */
function compileNodeDef(nodeDef, index = 0) {
    validateNodeDef(nodeDef, index);

    // Parse output
    const outputExpr = parseExpr(stringToSchemaPattern(nodeDef.output));
    const canonicalOutput = renderExpr(outputExpr);

    // Validate no duplicate variables in output
    validateNoDuplicateVariables(outputExpr, nodeDef.output);

    // Parse inputs
    const inputExprs = nodeDef.inputs.map(stringToSchemaPattern).map(parseExpr);
    const canonicalInputs = inputExprs.map(renderExpr);

    // Validate no duplicate variables in any input
    for (let i = 0; i < nodeDef.inputs.length; i++) {
        const inputExpr = inputExprs[i];
        const inputStr = nodeDef.inputs[i];
        if (inputExpr && inputStr) {
            validateNoDuplicateVariables(inputExpr, inputStr);
        }
    }

    // Extract head and arity from output
    const head = outputExpr.name;
    const arity = outputExpr.args.length;

    // Determine if output is a pattern (contains variables)
    const outputVars = extractVariables(outputExpr);
    const isPattern = outputVars.size > 0;

    // Find repeated variable positions
    const repeatedVarPositions = findRepeatedVarPositions(outputExpr);

    // Extract variables used in inputs
    const varsUsedInInputs = new Set();
    for (const inputExpr of inputExprs) {
        const vars = extractVariables(inputExpr);
        for (const v of vars) {
            varsUsedInInputs.add(v);
        }
    }

    // Validate variable coverage
    validateVariableCoverage(outputExpr, inputExprs, nodeDef.output);

    return {
        source: nodeDef,
        outputExpr,
        canonicalOutput,
        inputExprs,
        canonicalInputs,
        head,
        arity,
        isPattern,
        repeatedVarPositions,
        varsUsedInInputs,
    };
}

/**
 * Creates a mapping from variable names to their positions in the output pattern.
 * Used to translate from named variables to positional bindings.
 * @param {ParsedExpr} outputExpr - The output expression pattern
 * @returns {Map<string, number>} Map from variable name to position index
 */
function createVariablePositionMap(outputExpr) {
    /** @type {Map<string, number>} */
    const varToPosition = new Map();

    if (outputExpr.kind === "call") {
        for (let i = 0; i < outputExpr.args.length; i++) {
            const arg = outputExpr.args[i];
            if (arg === undefined) continue;

            if (arg.kind === "identifier") {
                const varName = arg.value;
                // Use first occurrence if variable appears multiple times
                if (!varToPosition.has(varName)) {
                    varToPosition.set(varName, i);
                }
            }
        }
    }

    return varToPosition;
}

/**
 * Extracts positional bindings for an input pattern based on variable name mapping.
 * Given an output's positional bindings and the input pattern's variables,
 * creates the input's positional bindings by looking up each variable's position in the output.
 * @param {ParsedExpr} inputExpr - The input pattern expression
 * @param {Array<ConstValue>} outputBindings - The positional bindings for the output
 * @param {Map<string, number>} varToPosition - Map from variable name to position in output
 * @returns {Array<ConstValue>} Positional bindings for the input pattern
 */
function extractInputBindings(inputExpr, outputBindings, varToPosition) {
    if (inputExpr.kind === "atom") {
        return [];
    }

    // For call expressions, map each argument variable to its binding value
    const inputBindings = [];
    for (const arg of inputExpr.args) {
        if (arg.kind === "identifier") {
            const varName = arg.value;
            const position = varToPosition.get(varName);
            if (position === undefined) {
                throw new Error(
                    `Variable '${varName}' not found in output pattern (should have been caught by validation)`,
                );
            }
            const binding = outputBindings[position];
            if (binding === undefined) {
                throw new Error(
                    `No binding provided for variable '${varName}' at position ${position}`,
                );
            }
            inputBindings.push(binding);
        }
    }

    return inputBindings;
}

module.exports = {
    compileNodeDef,
    extractVariables,
    validateNoOverlap,
    validateAcyclic,
    validateSingleArityPerHead,
    validateInputArities,
    patternsCanOverlap,
    createVariablePositionMap,
    extractInputBindings,
};
