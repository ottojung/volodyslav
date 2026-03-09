/**
 * Pull operations for IncrementalGraph.
 */

/** @typedef {import('./graph_storage').BatchBuilder} BatchBuilder */
/** @typedef {import('./types').ComputedValue} ComputedValue */
/** @typedef {import('./types').ConstValue} ConstValue */
/** @typedef {import('./types').NodeName} NodeName */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */
/** @typedef {import('./types').RecomputeResult} RecomputeResult */
/**
 * @typedef {object} IncrementalGraphPullAccess
 * @property {Map<NodeName, import('./types').CompiledNode>} headIndex
 * @property {import('../../sleeper').SleepCapability} sleeper
 * @property {import('./graph_storage').GraphStorage} storage
 * @property {(nodeKeyStr: NodeKeyString, compiledNode: import('./types').CompiledNode, bindings: Array<ConstValue>) => import('./types').ConcreteNode} getOrCreateConcreteNode
 * @property {(nodeDefinition: import('./types').ConcreteNode, batch: BatchBuilder) => Promise<RecomputeResult>} maybeRecalculate
 */

const { nodeKeyStringToString, stringToNodeName } = require("./database");
const { makeInvalidNodeError } = require("./errors");
const { withMutex } = require("./lock");
const { deserializeNodeKey, serializeNodeKey } = require("./node_key");
const { checkArity, ensureNodeNameIsHead } = require("./shared");

/**
 * @param {IncrementalGraphPullAccess} incrementalGraph
 * @param {string} nodeName
 * @param {Array<ConstValue>} bindings
 * @returns {Promise<ComputedValue>}
 */
async function internalUnsafePull(
    incrementalGraph,
    nodeName,
    bindings
) {
    ensureNodeNameIsHead(nodeName);
    const nodeNameValue = stringToNodeName(nodeName);
    const { value } = await internalPullWithStatus(
        incrementalGraph,
        nodeNameValue,
        bindings
    );
    return value;
}

/**
 * @param {IncrementalGraphPullAccess} incrementalGraph
 * @param {string} nodeName
 * @param {Array<ConstValue>} [bindings=[]]
 * @returns {Promise<ComputedValue>}
 */
async function internalPull(
    incrementalGraph,
    nodeName,
    bindings = []
) {
    return withMutex(incrementalGraph.sleeper, () =>
        internalUnsafePull(incrementalGraph, nodeName, bindings)
    );
}

/**
 * @param {IncrementalGraphPullAccess} incrementalGraph
 * @param {NodeName} nodeName
 * @param {Array<ConstValue>} [bindings=[]]
 * @returns {Promise<RecomputeResult>}
 */
async function internalPullWithStatus(
    incrementalGraph,
    nodeName,
    bindings = []
) {
    const nodeKey = { head: nodeName, args: bindings };
    const concreteKey = serializeNodeKey(nodeKey);
    return await internalPullByNodeKeyStringWithStatus(incrementalGraph, concreteKey);
}

/**
 * @param {IncrementalGraphPullAccess} incrementalGraph
 * @param {NodeKeyString} nodeKeyStr
 * @returns {Promise<RecomputeResult>}
 */
async function internalPullByNodeKeyStringWithStatus(
    incrementalGraph,
    nodeKeyStr
) {
    /**
     * @param {BatchBuilder} batch
     * @returns {Promise<RecomputeResult>}
     */
    const run = async (batch) => {
        const nodeKey = deserializeNodeKey(nodeKeyStr);
        const nodeName = nodeKey.head;
        const bindings = nodeKey.args;
        const compiledNode = incrementalGraph.headIndex.get(nodeName);
        if (!compiledNode) {
            throw makeInvalidNodeError(nodeName);
        }

        checkArity(compiledNode, bindings);

        const nodeDefinition = incrementalGraph.getOrCreateConcreteNode(
            nodeKeyStr,
            compiledNode,
            bindings
        );
        const nodeFreshness = await batch.freshness.get(nodeKeyStr);

        if (nodeFreshness === "up-to-date") {
            const result = await batch.values.get(nodeKeyStr);
            if (result === undefined) {
                throw new Error(
                    `Impossible: up-to-date node has no stored value: ${nodeKeyStringToString(nodeKeyStr)}`
                );
            }
            return { value: result, status: "cached" };
        }

        return await incrementalGraph.maybeRecalculate(
            nodeDefinition,
            batch
        );
    };
    return incrementalGraph.storage.withBatch(run);
}

module.exports = {
    internalPull,
    internalPullByNodeKeyStringWithStatus,
    internalPullWithStatus,
    internalUnsafePull,
};
