/**
 * Shared validation helpers for IncrementalGraph.
 */

const {
    stringToSchemaPattern,
} = require("./database");
const {
    makeArityMismatchError,
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

module.exports = {
    checkArity,
    ensureNodeNameIsHead,
};
