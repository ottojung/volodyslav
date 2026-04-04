/**
 * Shared validation helpers for IncrementalGraph.
 */

const {
    stringToSchemaPattern,
} = require("./database");
const {
    makeArityMismatchError,
    makeInvalidBindingsError,
    makeInvalidNodeNameError,
    makeSchemaPatternNotAllowedError,
} = require("./errors");
const { checkIfIdentifier, parseExpr } = require("./expr");

/**
 * Ensures the public API receives a node name (head) rather than a schema pattern.
 * @param {string} nodeName
 */
function ensureNodeNameIsHead(nodeName) {
    if (checkIfIdentifier(nodeName)) {
        return;
    }

    let parsed;
    try {
        const schemaPattern = stringToSchemaPattern(nodeName);
        parsed = parseExpr(schemaPattern);
    } catch (error) {
        throw makeInvalidNodeNameError(nodeName);
    }
    if (parsed.kind === "call") {
        throw makeSchemaPatternNotAllowedError(nodeName);
    }
    throw makeInvalidNodeNameError(nodeName);
}

/**
 * Validates that the arity of the compiled node matches the provided bindings.
 * @param {import('./types').CompiledNode} compiledNode
 * @param {Array<import('./types').ConstValue>} bindings
 * @returns {void}
 */
function checkArity(compiledNode, bindings) {
    if (compiledNode.arity !== bindings.length) {
        throw makeArityMismatchError(
            compiledNode.head,
            compiledNode.arity,
            bindings.length
        );
    }
}

/**
 * Extracts variable names in order from a compiled node's output expression.
 * @param {import('./types').CompiledNode} compiledNode
 * @returns {Array<string>}
 */
function extractVarNames(compiledNode) {
    if (compiledNode.arity === 0) {
        return [];
    }
    const varNames = [];
    if (compiledNode.outputExpr.kind === "call") {
        for (const arg of compiledNode.outputExpr.args) {
            if (arg.kind === "identifier") {
                varNames.push(arg.value);
            }
        }
    }
    return varNames;
}

/**
 * Converts a key-value bindings map to a positional array.
 * Uses the variable names from the schema's output expression in order.
 * @param {import('./types').CompiledNode} compiledNode
 * @param {Record<string, import('./types').ConstValue>} bindings
 * @returns {Array<import('./types').ConstValue>}
 */
function bindingsMapToPositional(compiledNode, bindings) {
    const varNames = extractVarNames(compiledNode);
    const expectedKeys = new Set(varNames);
    const actualKeys = new Set(Object.keys(bindings));
    for (const key of expectedKeys) {
        if (!actualKeys.has(key)) {
            throw makeInvalidBindingsError(compiledNode.head, expectedKeys, actualKeys);
        }
    }
    for (const key of actualKeys) {
        if (!expectedKeys.has(key)) {
            throw makeInvalidBindingsError(compiledNode.head, expectedKeys, actualKeys);
        }
    }
    return varNames.map((name) => bindings[name]);
}

/**
 * Converts a positional bindings array to a key-value map.
 * Uses the variable names from the schema's output expression.
 * @param {import('./types').CompiledNode} compiledNode
 * @param {Array<import('./types').ConstValue>} positionalArgs
 * @returns {Record<string, import('./types').ConstValue>}
 */
function positionalToBindingsMap(compiledNode, positionalArgs) {
    const varNames = extractVarNames(compiledNode);
    /** @type {Record<string, import('./types').ConstValue>} */
    const result = {};
    for (let i = 0; i < varNames.length; i++) {
        result[varNames[i]] = positionalArgs[i];
    }
    return result;
}

module.exports = {
    checkArity,
    ensureNodeNameIsHead,
    bindingsMapToPositional,
    positionalToBindingsMap,
};
