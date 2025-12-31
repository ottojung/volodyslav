/**
 * Compilation of node definitions into CompiledNode with cached metadata.
 */

const { parseExpr, renderExpr } = require("./expr");
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
 * Checks if two patterns can potentially match the same concrete keys.
 * Uses pattern unification: attempts to find a common substitution that makes both patterns equal.
 * Takes into account:
 * - Constants must match exactly
 * - Repeated variables in the same pattern enforce equality constraints
 * 
 * @param {CompiledNode} node1
 * @param {CompiledNode} node2
 * @returns {boolean} True if patterns can overlap
 */
function patternsCanOverlap(node1, node2) {
    // Must have same head and arity to overlap
    if (node1.head !== node2.head || node1.arity !== node2.arity) {
        return false;
    }

    // Track variable bindings for unification
    /** @type {Map<string, ConstValue | string>} */
    const bindings1 = new Map(); // Variables from node1
    /** @type {Map<string, ConstValue | string>} */
    const bindings2 = new Map(); // Variables from node2

    // Try to unify each argument position
    for (let i = 0; i < node1.arity; i++) {
        const arg1 = node1.outputExpr.args[i];
        const arg2 = node2.outputExpr.args[i];
        
        if (arg1 === undefined || arg2 === undefined) {
            return false;
        }

        const isVar1 = arg1.kind === "identifier";
        const isVar2 = arg2.kind === "identifier";

        if (!isVar1 && !isVar2) {
            // Both are constants - must match exactly
            const const1 = argToConstValue(arg1);
            const const2 = argToConstValue(arg2);
            
            if (const1 === null || const2 === null) {
                return false;
            }
            
            if (const1.kind !== const2.kind || const1.value !== const2.value) {
                return false; // Conflicting constants - no overlap
            }
        } else if (isVar1 && !isVar2) {
            // arg1 is variable, arg2 is constant
            const varName = arg1.value;
            const constValue = argToConstValue(arg2);
            
            if (constValue === null) {
                return false;
            }
            
            if (bindings1.has(varName)) {
                // Variable already bound - check consistency
                const existing = bindings1.get(varName);
                if (typeof existing === "string") {
                    // Bound to another variable - continue
                } else if (existing) {
                    // Bound to a constant - must match
                    if (existing.kind !== constValue.kind || existing.value !== constValue.value) {
                        return false; // Inconsistent binding
                    }
                }
            } else {
                // Bind variable to constant
                bindings1.set(varName, constValue);
            }
        } else if (!isVar1 && isVar2) {
            // arg1 is constant, arg2 is variable
            const constValue = argToConstValue(arg1);
            const varName = arg2.value;
            
            if (constValue === null) {
                return false;
            }
            
            if (bindings2.has(varName)) {
                // Variable already bound - check consistency
                const existing = bindings2.get(varName);
                if (typeof existing === "string") {
                    // Bound to another variable - continue
                } else if (existing) {
                    // Bound to a constant - must match
                    if (existing.kind !== constValue.kind || existing.value !== constValue.value) {
                        return false; // Inconsistent binding
                    }
                }
            } else {
                // Bind variable to constant
                bindings2.set(varName, constValue);
            }
        } else {
            // Both are variables
            const var1 = arg1.value;
            const var2 = arg2.value;
            
            // Check if either is already bound
            const bound1 = bindings1.get(var1);
            const bound2 = bindings2.get(var2);
            
            if (bound1 && bound2) {
                // Both bound - check consistency
                if (typeof bound1 !== "string" && typeof bound2 !== "string") {
                    // Both bound to constants
                    if (bound1.kind !== bound2.kind || bound1.value !== bound2.value) {
                        return false;
                    }
                }
            }
            
            // Create binding (simplified - just note they must be equal in any unifying substitution)
            // For a more complete implementation, we'd track variable-to-variable bindings
        }
    }

    // If we get here, patterns can potentially overlap
    return true;
}

/**
 * Validates that no two compiled nodes have overlapping patterns.
 * @param {CompiledNode[]} compiledNodes
 * @throws {Error} If patterns overlap
 */
function validateNoOverlap(compiledNodes) {
    for (let i = 0; i < compiledNodes.length; i++) {
        for (let j = i + 1; j < compiledNodes.length; j++) {
            const node1 = compiledNodes[i];
            const node2 = compiledNodes[j];
            
            if (node1 === undefined || node2 === undefined) {
                throw new Error("Unexpected undefined node in validation");
            }
            
            if (patternsCanOverlap(node1, node2)) {
                throw makeInvalidSchemaError(
                    `Overlaps with node '${node2.canonicalOutput}'`,
                    node1.canonicalOutput
                );
            }
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
    validateNoOverlap,
    patternsCanOverlap,
};
