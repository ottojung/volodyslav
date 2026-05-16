/**
 * Pull operations for IncrementalGraph.
 */

/** @typedef {import('./graph_storage').BatchBuilder} BatchBuilder */
/** @typedef {import('./types').ComputedValue} ComputedValue */
/** @typedef {import('./types').ConstValue} ConstValue */
/** @typedef {import('./types').NodeName} NodeName */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */
/** @typedef {import('./types').RecomputeResult} RecomputeResult */
/** @typedef {import('./identifier_resolver').IdentifierResolver} IdentifierResolver */
/**
 * @typedef {object} IncrementalGraphPullAccess
 * @property {Map<NodeName, import('./types').CompiledNode>} headIndex
 * @property {import('../../sleeper').SleepCapability} sleeper
 * @property {import('./graph_storage').GraphStorage} storage
 * @property {() => IdentifierResolver} makeIdentifierResolver
 * @property {(identifierResolver: IdentifierResolver, procedure: (batch: BatchBuilder) => Promise<RecomputeResult>) => Promise<RecomputeResult>} withIdentifierBatch
 * @property {(nodeDefinition: import('./types').ConcreteNode, identifierResolver: IdentifierResolver) => import('./types').ResolvedConcreteNode} resolveConcreteNode
 * @property {(nodeKeyStr: NodeKeyString, compiledNode: import('./types').CompiledNode, bindings: Array<ConstValue>) => import('./types').ConcreteNode} getOrCreateConcreteNode
 * @property {(nodeDefinition: import('./types').ResolvedConcreteNode, batch: BatchBuilder, identifierResolver: IdentifierResolver) => Promise<RecomputeResult>} maybeRecalculate
 */

const { nodeKeyStringToString, stringToNodeName } = require("./database");
const { makeInvalidNodeError } = require("./errors");
const { withPullMode, withPullNodeMutex } = require("./lock");
const { deserializeNodeKey, serializeNodeKey } = require("./database");
const { checkArity, ensureNodeNameIsHead } = require("./shared");

/**
 * Pull implementation that assumes the caller has already acquired the global
 * pull-mode lock.
 *
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
    return withPullMode(incrementalGraph.sleeper, () =>
        internalUnsafePull(incrementalGraph, nodeName, bindings)
    );
}

/**
 * Pull-with-status implementation that acquires the global pull-mode lock
 * and then delegates to internalPullWithStatus.
 *
 * @param {IncrementalGraphPullAccess} incrementalGraph
 * @param {NodeName} nodeName
 * @param {Array<ConstValue>} [bindings=[]]
 * @returns {Promise<RecomputeResult>}
 */
async function internalSafePullWithStatus(
    incrementalGraph,
    nodeName,
    bindings = []
) {
    return withPullMode(incrementalGraph.sleeper, () =>
        internalPullWithStatus(incrementalGraph, nodeName, bindings)
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
    return await internalPullByNodeKeyStringWithStatusDuringPull(
        incrementalGraph,
        concreteKey,
        incrementalGraph.makeIdentifierResolver()
    );
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
    return withPullMode(incrementalGraph.sleeper, () =>
        internalPullByNodeKeyStringWithStatusDuringPull(
            incrementalGraph,
            nodeKeyStr
        )
    );
}

/**
 * @param {IncrementalGraphPullAccess} incrementalGraph
 * @param {NodeKeyString} nodeKeyStr
 * @param {IdentifierResolver} [identifierResolver=incrementalGraph.makeIdentifierResolver()]
 * @returns {Promise<RecomputeResult>}
 */
async function internalPullByNodeKeyStringWithStatusDuringPull(
    incrementalGraph,
    nodeKeyStr,
    identifierResolver = incrementalGraph.makeIdentifierResolver()
) {
    const nodeKey = deserializeNodeKey(nodeKeyStr);
    const nodeName = nodeKey.head;
    const bindings = nodeKey.args;
    const compiledNode = incrementalGraph.headIndex.get(nodeName);
    if (!compiledNode) {
        throw makeInvalidNodeError(nodeName);
    }

    checkArity(compiledNode, bindings);

    const concreteNode = incrementalGraph.getOrCreateConcreteNode(
        nodeKeyStr,
        compiledNode,
        bindings
    );

    /**
     * @param {BatchBuilder} batch
     * @returns {Promise<RecomputeResult>}
     */
    const run = async (batch) => {
        const outputIdentifier = identifierResolver.getOrAllocateNodeIdentifier(
            concreteNode.output
        );
        const nodeFreshness = await batch.freshness.get(
            outputIdentifier
        );

        if (nodeFreshness === "up-to-date") {
            const result = await batch.values.get(outputIdentifier);
            if (result === undefined) {
                throw new Error(
                    `Impossible: up-to-date node has no stored value: ${nodeKeyStringToString(nodeKeyStr)}`
                );
            }
            return { value: result, status: "cached" };
        }

        const nodeDefinition = incrementalGraph.resolveConcreteNode(
            concreteNode,
            identifierResolver
        );
        return await incrementalGraph.maybeRecalculate(
            nodeDefinition,
            batch,
            identifierResolver
        );
    };
    return withPullNodeMutex(incrementalGraph.sleeper, nodeKeyStr, () =>
        incrementalGraph.withIdentifierBatch(identifierResolver, run)
    );
}

module.exports = {
    internalPull,
    internalPullByNodeKeyStringWithStatusDuringPull,
    internalPullByNodeKeyStringWithStatus,
    internalSafePullWithStatus,
    internalPullWithStatus,
    internalUnsafePull,
};
