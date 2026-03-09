/**
 * Pull operations for IncrementalGraph.
 */

/** @typedef {import('./class').IncrementalGraph} IncrementalGraph */
/** @typedef {import('./graph_storage').BatchBuilder} BatchBuilder */
/** @typedef {import('./types').ComputedValue} ComputedValue */
/** @typedef {import('./types').ConstValue} ConstValue */
/** @typedef {import('./types').NodeName} NodeName */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */
/** @typedef {import('./types').RecomputeResult} RecomputeResult */

const { nodeKeyStringToString, stringToNodeName } = require("./database");
const { makeInvalidNodeError } = require("./errors");
const { withMutex } = require("./lock");
const { deserializeNodeKey, serializeNodeKey } = require("./node_key");
const { checkArity, ensureNodeNameIsHead } = require("./shared");

/**
 * @param {IncrementalGraph} incrementalGraph
 * @param {string} nodeName
 * @param {Array<ConstValue>} bindings
 * @param {BatchBuilder | undefined} externalBatch
 * @returns {Promise<ComputedValue>}
 */
async function internalUnsafePull(
    incrementalGraph,
    nodeName,
    bindings,
    externalBatch = undefined
) {
    ensureNodeNameIsHead(nodeName);
    const nodeNameValue = stringToNodeName(nodeName);
    const { value } = await internalPullWithStatus(
        incrementalGraph,
        nodeNameValue,
        bindings,
        externalBatch
    );
    return value;
}

/**
 * @param {IncrementalGraph} incrementalGraph
 * @param {string} nodeName
 * @param {Array<ConstValue>} [bindings=[]]
 * @param {BatchBuilder | undefined} [externalBatch]
 * @returns {Promise<ComputedValue>}
 */
async function internalPull(
    incrementalGraph,
    nodeName,
    bindings = [],
    externalBatch = undefined
) {
    return withMutex(incrementalGraph.sleeper, () =>
        internalUnsafePull(incrementalGraph, nodeName, bindings, externalBatch)
    );
}

/**
 * @param {IncrementalGraph} incrementalGraph
 * @param {NodeName} nodeName
 * @param {Array<ConstValue>} [bindings=[]]
 * @param {BatchBuilder | undefined} [externalBatch]
 * @returns {Promise<RecomputeResult>}
 */
async function internalPullWithStatus(
    incrementalGraph,
    nodeName,
    bindings = [],
    externalBatch = undefined
) {
    const nodeKey = { head: nodeName, args: bindings };
    const concreteKey = serializeNodeKey(nodeKey);
    return await internalPullByNodeKeyStringWithStatus(
        incrementalGraph,
        concreteKey,
        externalBatch
    );
}

/**
 * @param {IncrementalGraph} incrementalGraph
 * @param {NodeKeyString} nodeKeyStr
 * @param {BatchBuilder | undefined} [externalBatch]
 * @returns {Promise<RecomputeResult>}
 */
async function internalPullByNodeKeyStringWithStatus(
    incrementalGraph,
    nodeKeyStr,
    externalBatch = undefined
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
            batch,
            externalBatch
        );
    };

    if (externalBatch !== undefined) {
        return run(externalBatch);
    }
    return incrementalGraph.storage.withBatch(run);
}

module.exports = {
    internalPull,
    internalPullByNodeKeyStringWithStatus,
    internalPullWithStatus,
    internalUnsafePull,
};
