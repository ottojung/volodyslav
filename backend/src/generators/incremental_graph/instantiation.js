/**
 * Concrete node instantiation helpers for IncrementalGraph.
 */

const {
    createVariablePositionMap,
    extractInputBindings,
} = require("./compiled_node");
const { renderExpr } = require("./expr");
const { createNodeKeyFromPattern, serializeNodeKey } = require("./database");

/** @typedef {import('./types').CompiledNode} CompiledNode */
/** @typedef {import('./types').ConcreteNode} ConcreteNode */
/** @typedef {import('./types').ConcreteNodeComputor} ConcreteNodeComputor */
/** @typedef {import('./types').ConstValue} ConstValue */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */
/**
 * @typedef {object} IncrementalGraphInstantiationAccess
 * @property {import('./lru_cache').ConcreteNodeCache} concreteInstantiations
 */

/**
 * Gets or creates a concrete node instantiation.
 * Dynamic edges are persisted to DB when the node is computed/set, not here.
 * This is a runtime-only function that operates on instance data, not schema patterns.
 * @param {IncrementalGraphInstantiationAccess} incrementalGraph
 * @param {NodeKeyString} concreteKeyCanonical
 * @param {CompiledNode} compiledNode
 * @param {Array<ConstValue>} bindings
 * @returns {ConcreteNode}
 */
function internalGetOrCreateConcreteNode(
    incrementalGraph,
    concreteKeyCanonical,
    compiledNode,
    bindings
) {
    const concreteKeyString = concreteKeyCanonical;
    const cached = incrementalGraph.concreteInstantiations.get(concreteKeyString);
    if (cached) {
        return cached;
    }

    if (!compiledNode.isPattern) {
        const jsonInputs = compiledNode.canonicalInputs.map((input) => {
            const inputKey = createNodeKeyFromPattern(input, []);
            return serializeNodeKey(inputKey);
        });

        const concreteNode = {
            output: concreteKeyString,
            inputs: jsonInputs,
            /** @type {ConcreteNodeComputor} */
            computor: (inputs, oldValue) =>
                compiledNode.source.computor(inputs, oldValue, []),
        };
        incrementalGraph.concreteInstantiations.set(
            concreteKeyString,
            concreteNode
        );
        return concreteNode;
    }

    const varToPosition = createVariablePositionMap(compiledNode.outputExpr);
    const concreteInputs = compiledNode.inputExprs.map((inputExpr) => {
        const inputBindings = extractInputBindings(
            inputExpr,
            bindings,
            varToPosition
        );
        const inputPattern = renderExpr(inputExpr);
        const inputKey = createNodeKeyFromPattern(inputPattern, inputBindings);
        return serializeNodeKey(inputKey);
    });

    const concreteNode = {
        output: concreteKeyString,
        inputs: concreteInputs,
        /** @type {ConcreteNodeComputor} */
        computor: (inputValues, oldValue) =>
            compiledNode.source.computor(inputValues, oldValue, bindings),
    };

    incrementalGraph.concreteInstantiations.set(concreteKeyString, concreteNode);
    return concreteNode;
}

module.exports = {
    internalGetOrCreateConcreteNode,
};
