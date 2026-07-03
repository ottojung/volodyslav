const {
    compileNodeDef,
    validateNoOverlap,
    validateAcyclic,
    validateSingleArityPerHead,
    validateInputArities,
} = require("./compiled_node");

const {
    buildGraphSchemeFromNodeDefs,
    buildGraphSchemeStringFromNodeDefs,
} = require("./database");

/** @typedef {import('./types').NodeDef} NodeDef */
/** @typedef {import('./types').CompiledNode} CompiledNode */
/** @typedef {import('./database/graph_scheme').GraphScheme} GraphScheme */
/** @typedef {import('./types').NodeName} NodeName */

/**
 * @typedef {object} CompiledValidatedGraphSchema
 * @property {CompiledNode[]} compiledNodes
 * @property {Map<NodeName, CompiledNode>} headIndex
 * @property {GraphScheme} graphScheme
 * @property {string} graphSchemeString
 */

/**
 * Compile and validate node definitions, building all derived schema objects.
 *
 * Runs all cross-node validators:
 * - validateNoOverlap
 * - validateAcyclic
 * - validateSingleArityPerHead
 * - validateInputArities
 *
 * Then builds headIndex, graphScheme, and graphSchemeString from the validated
 * compiled nodes.
 *
 * @param {Array<NodeDef>} nodeDefs
 * @returns {CompiledValidatedGraphSchema}
 */
function compileValidatedGraphSchema(nodeDefs) {
    const compiledNodes = nodeDefs.map(compileNodeDef);

    validateNoOverlap(compiledNodes);
    validateAcyclic(compiledNodes);
    validateSingleArityPerHead(compiledNodes);
    validateInputArities(compiledNodes);

    const graphScheme = buildGraphSchemeFromNodeDefs(compiledNodes);
    const graphSchemeString = buildGraphSchemeStringFromNodeDefs(compiledNodes);

    /** @type {Map<NodeName, CompiledNode>} */
    const headIndex = new Map();
    for (const compiledNode of compiledNodes) {
        headIndex.set(compiledNode.head, compiledNode);
    }

    return {
        compiledNodes,
        headIndex,
        graphScheme,
        graphSchemeString,
    };
}

module.exports = {
    compileValidatedGraphSchema,
};
