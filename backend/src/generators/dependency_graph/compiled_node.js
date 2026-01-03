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
/** @typedef {import('./types').ConstValue} ConstValue */
/** @typedef {import('./expr').ParsedExpr} ParsedExpr */
/** @typedef {import('./expr').ParsedArg} ParsedArg */

/**
 * A variable reference used during unification.
 * @typedef {object} UnificationVar
 * @property {'var'} kind - Discriminator for variable references
 * @property {'node1' | 'node2'} source - Which node the variable comes from
 * @property {string} name - Variable name
 */

/**
 * Value used during unification - either a constant or a variable reference.
 * @typedef {ConstValue | UnificationVar} UnificationValue
 */

/**
 * Converts a ParsedArg to a ConstValue if it's a constant.
 * @param {ParsedArg} arg
 * @returns {ConstValue | null} - Returns null if arg is a variable (identifier)
 */
function argToConstValue(arg) {
    if (arg.kind === "identifier") {
        return null; // Variable
    } else if (arg.kind === "string") {
        return { type: "string", value: arg.value };
    } else if (arg.kind === "number") {
        return { type: "int", value: parseInt(arg.value, 10) };
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
 * Minimal node interface for pattern overlap checking.
 * @typedef {object} PatternNode
 * @property {string} head - The function/atom head
 * @property {number} arity - Number of arguments
 * @property {ParsedExpr} outputExpr - The output expression
 */

/**
 * Checks if two patterns can potentially match the same concrete keys.
 * Uses pattern unification: attempts to find a common substitution that makes both patterns equal.
 * Takes into account:
 * - Constants must match exactly
 * - Repeated variables in the same pattern enforce equality constraints
 * 
 * @param {PatternNode} node1
 * @param {PatternNode} node2
 * @returns {boolean} True if patterns can overlap
 */
function patternsCanOverlap(node1, node2) {
    // Must have same head and arity to overlap
    if (node1.head !== node2.head || node1.arity !== node2.arity) {
        return false;
    }

    // Track variable bindings for unification
    // Maps variable names to what they're bound to (either a ConstValue or another variable name with "node1:" or "node2:" prefix)
    /** @type {Map<string, UnificationValue>} */
    const bindings1 = new Map(); // Variables from node1
    /** @type {Map<string, UnificationValue>} */
    const bindings2 = new Map(); // Variables from node2

    /**
     * Resolves a variable binding to its ultimate value.
     * @param {Map<string, UnificationValue>} bindings
     * @param {string} varName
     * @returns {UnificationValue | null}
     */
    function resolve(bindings, varName) {
        const binding = bindings.get(varName);
        if (!binding) return null;
        
        if (typeof binding === 'object' && 'kind' in binding) {
            if (binding.kind === 'var') {
                // Follow the chain
                const otherBindings = binding.source === 'node1' ? bindings1 : bindings2;
                return resolve(otherBindings, binding.name);
            }
        }
        // It's a ConstValue (has 'type' field)
        return binding;
    }

    /**
     * Binds a variable to a value, checking for conflicts.
     * @param {Map<string, UnificationValue>} bindings
     * @param {string} varName
     * @param {UnificationValue} value
     * @returns {boolean} True if binding succeeds, false if conflict
     */
    function bind(bindings, varName, value) {
        const existing = resolve(bindings, varName);
        if (existing === null) {
            bindings.set(varName, value);
            return true;
        }
        
        // Check if existing binding is compatible
        if ('kind' in existing && existing.kind === 'var' && 'kind' in value && value.kind === 'var') {
            // Both are variables - make them equal
            const otherBindings = value.source === 'node1' ? bindings1 : bindings2;
            return bind(otherBindings, value.name, existing);
        } else if ('type' in existing && 'type' in value) {
            // Both are constants - must match
            return existing.type === value.type && existing.value === value.value;
        } else if ('kind' in existing && existing.kind === 'var') {
            // Existing is var, value is const - bind the var
            const otherBindings = existing.source === 'node1' ? bindings1 : bindings2;
            return bind(otherBindings, existing.name, value);
        } else {
            // Existing is const, value is var - bind the var
            if ('kind' in value && value.kind === 'var') {
                const otherBindings = value.source === 'node1' ? bindings1 : bindings2;
                return bind(otherBindings, value.name, existing);
            }
            return false;
        }
    }

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
            
            if (const1.type !== const2.type || const1.value !== const2.value) {
                return false; // Conflicting constants - no overlap
            }
        } else if (isVar1 && !isVar2) {
            // arg1 is variable, arg2 is constant
            const varName = arg1.value;
            const constValue = argToConstValue(arg2);
            
            if (constValue === null) {
                return false;
            }
            
            if (!bind(bindings1, varName, constValue)) {
                return false; // Inconsistent binding
            }
        } else if (!isVar1 && isVar2) {
            // arg1 is constant, arg2 is variable
            const constValue = argToConstValue(arg1);
            const varName = arg2.value;
            
            if (constValue === null) {
                return false;
            }
            
            if (!bind(bindings2, varName, constValue)) {
                return false; // Inconsistent binding
            }
        } else {
            // Both are variables - unify them
            const var1 = arg1.value;
            const var2 = arg2.value;
            
            if (!bind(bindings1, var1, { kind: 'var', source: 'node2', name: var2 })) {
                return false; // Inconsistent binding
            }
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
            // Only needs outputExpr, head, and arity properties
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
    validateAcyclic,
    patternsCanOverlap,
};
