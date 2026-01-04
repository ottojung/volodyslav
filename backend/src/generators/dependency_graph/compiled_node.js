/**
 * Compilation of node definitions into CompiledNode with cached metadata.
 */

const { parseExpr, renderExpr } = require("./expr");
const { 
    makeInvalidSchemaError, 
    makeSchemaOverlapError, 
    makeSchemaCycleError 
} = require("./errors");

/** @typedef {import('./types').NodeDef} NodeDef */
/** @typedef {import('./types').CompiledNode} CompiledNode */
/** @typedef {import('./expr').ParsedExpr} ParsedExpr */
/** @typedef {import('./expr').ParsedArg} ParsedArg */

/**
 * Extracts variable names from a parsed expression.
 * All identifiers in arguments are variables.
 * @param {ParsedExpr} expr
 * @returns {Set<string>}
 */
function extractVariables(expr) {
    /** @type {Set<string>} */
    const vars = new Set();
    
    if (expr.kind === "call") {
        for (const arg of expr.args) {
            // All args are identifiers (variables) now
            vars.add(arg.value);
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
 * Minimal pattern interface for overlap checking.
 * @typedef {object} PatternForOverlap
 * @property {ParsedExpr} outputExpr - The output expression  
 * @property {string} head - Head/name of the pattern
 * @property {number} arity - Number of arguments
 */

/**
 * Checks if two patterns can potentially match the same concrete keys.
 * With constants removed, patterns overlap if and only if they have
 * the same head (functor) and the same arity.
 * 
 * @param {PatternForOverlap} node1
 * @param {PatternForOverlap} node2
 * @returns {boolean} True if patterns can overlap
 */
function patternsCanOverlap(node1, node2) {
    // Patterns overlap if they have same head and arity
    return node1.head === node2.head && node1.arity === node2.arity;
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
                throw makeSchemaOverlapError(
                    [node1.canonicalOutput, node2.canonicalOutput]
                );
            }
        }
    }
}

/**
 * Validates that the schema graph is acyclic.
 * @param {CompiledNode[]} compiledNodes
 * @throws {Error} If a cycle is detected
 */
function validateAcyclic(compiledNodes) {
    // Build adjacency list
    /** @type {Map<CompiledNode, CompiledNode[]>} */
    const adj = new Map();
    for (const node of compiledNodes) {
        adj.set(node, []);
    }

    for (const node of compiledNodes) {
        for (const inputExpr of node.inputExprs) {
            // Create a dummy node for the input pattern to check overlap
            const inputDummy = {
                outputExpr: inputExpr,
                head: inputExpr.name,
                arity: inputExpr.kind === 'call' ? inputExpr.args.length : 0,
            };

            for (const potentialDep of compiledNodes) {
                if (patternsCanOverlap(inputDummy, potentialDep)) {
                    const deps = adj.get(node);
                    if (deps) {
                        deps.push(potentialDep);
                    }
                }
            }
        }
    }

    // DFS for cycle detection
    /** @type {Set<CompiledNode>} */
    const visited = new Set();
    /** @type {Set<CompiledNode>} */
    const recursionStack = new Set();

    /**
     * @param {CompiledNode} node
     */
    function dfs(node) {
        visited.add(node);
        recursionStack.add(node);

        const neighbors = adj.get(node) || [];
        for (const neighbor of neighbors) {
            if (!visited.has(neighbor)) {
                dfs(neighbor);
            } else if (recursionStack.has(neighbor)) {
                throw makeSchemaCycleError(
                    [node.canonicalOutput, neighbor.canonicalOutput]
                );
            }
        }

        recursionStack.delete(node);
    }

    for (const node of compiledNodes) {
        if (!visited.has(node)) {
            dfs(node);
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
    
    // Compute arg kinds - all arguments are now variables
    /** @type {Array<'var'>} */
    const outputArgKinds = [];
    /** @type {Array<null>} */
    const outputConstArgs = [];
    
    if (outputExpr.kind === "call") {
        for (let i = 0; i < outputExpr.args.length; i++) {
            // All args are identifiers (variables)
            outputArgKinds.push("var");
            outputConstArgs.push(null);
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
    validateAcyclic,
    patternsCanOverlap,
};
