/**
 * Compilation of node definitions into CompiledNode with cached metadata.
 */

const { parseExpr, canonicalize, renderExpr } = require("./expr");
const { makeInvalidSchemaError } = require("./errors");

/** @typedef {import('./types').NodeDef} NodeDef */
/** @typedef {import('./types').CompiledNode} CompiledNode */
/** @typedef {import('./types').ConstValue} ConstValue */
/** @typedef {import('./expr').ParsedExpr} ParsedExpr */
/** @typedef {import('./expr').ParsedArg} ParsedArg */

/**
 * Converts a ParsedArg to a ConstValue if it's a constant.
 * @param {ParsedArg} arg
 * @returns {ConstValue | null} - Returns null if arg is a variable (identifier)
 */
function argToConstValue(arg) {
    if (arg.kind === "identifier") {
        return null; // Variable
    } else if (arg.kind === "string") {
        return { kind: "string", value: arg.value };
    } else if (arg.kind === "number") {
        return { kind: "nat", value: parseInt(arg.value, 10) };
    }
    throw new Error(`Unknown arg kind: ${arg.kind}`);
}

/**
 * Extracts variable names from a parsed expression.
 * Variables are unquoted identifiers in arguments.
 * @param {ParsedExpr} expr
 * @returns {Set<string>}
 */
function extractVariables(expr) {
    /** @type {Set<string>} */
    const vars = new Set();
    
    if (expr.kind === "call") {
        for (const arg of expr.args) {
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
                outputStr
            );
        }
    }
}

/**
 * Compiles a node definition into a CompiledNode with all metadata cached.
 * @param {NodeDef} nodeDef
 * @returns {CompiledNode}
 */
function compileNodeDef(nodeDef) {
    // Parse output
    const outputExpr = parseExpr(nodeDef.output);
    const canonicalOutput = renderExpr(outputExpr);
    
    // Parse inputs
    const inputExprs = nodeDef.inputs.map(parseExpr);
    const canonicalInputs = inputExprs.map(renderExpr);
    
    // Extract head and arity from output
    const head = outputExpr.name;
    const arity = outputExpr.args.length;
    
    // Determine if output is a pattern (contains variables)
    const outputVars = extractVariables(outputExpr);
    const isPattern = outputVars.size > 0;
    
    // Compute arg kinds and constant values for output
    /** @type {Array<'var'|'const'>} */
    const outputArgKinds = [];
    /** @type {Array<ConstValue | null>} */
    const outputConstArgs = [];
    
    if (outputExpr.kind === "call") {
        for (const arg of outputExpr.args) {
            if (arg.kind === "identifier") {
                outputArgKinds.push("var");
                outputConstArgs.push(null);
            } else {
                outputArgKinds.push("const");
                outputConstArgs.push(argToConstValue(arg));
            }
        }
    }
    
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
        outputArgKinds,
        outputConstArgs,
        repeatedVarPositions,
        varsUsedInInputs,
    };
}

module.exports = {
    compileNodeDef,
    extractVariables,
    argToConstValue,
};
