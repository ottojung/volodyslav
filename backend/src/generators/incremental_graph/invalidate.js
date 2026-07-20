/**
 * Invalidation operations for IncrementalGraph.
 *
 * Transaction context is passed explicitly through the call stack.
 */

/** @typedef {import('./graph_state').BatchBuilder} BatchBuilder */
/** @typedef {import('./graph_state').Transaction} Transaction */
/** @typedef {import('./types').ConstValue} ConstValue */
/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */

/**
 * @typedef {object} IncrementalGraphInvalidateAccess
 * @property {Map<import('./types').NodeName, import('./types').CompiledNode>} headIndex
 * @property {import('../../sleeper').SleepCapability} sleeper
 * @property {import('./graph_state').GraphStorage} storage
 * @property {import('./lru_cache').ConcreteNodeCache} concreteInstantiations
 */

const { stringToNodeName, nodeIdentifierToString, serializeNodeKey, ReplicaStateInvariantError, normalizeInputEdges } = require("./database");
const { makeInvalidNodeError } = require("./errors");
const { daytimeActivity } = require("./lock");
const { checkArity, ensureNodeNameIsHead } = require("./shared");
const { lookupNodeIdentifier } = require("./graph_state");
const { internalGetOrCreateConcreteNode } = require("./instantiation");
const { invalidateDependentsFrom, revokeIncomingValidity } = require("./strong_invalidation");


/**
 * @param {IncrementalGraphInvalidateAccess} incrementalGraph
 * @param {string} nodeName
 * @param {Array<ConstValue>} bindings
 * @returns {Promise<void>}
 */
async function internalUnsafeInvalidate(
    incrementalGraph,
    nodeName,
    bindings
) {
    ensureNodeNameIsHead(nodeName);
    const nodeNameTyped = stringToNodeName(nodeName);
    const compiledNode = incrementalGraph.headIndex.get(nodeNameTyped);
    if (!compiledNode) {
        throw makeInvalidNodeError(nodeNameTyped);
    }

    checkArity(compiledNode, bindings);

    const nodeKey = { head: nodeNameTyped, args: bindings };
    const concreteKey = serializeNodeKey(nodeKey);

    await incrementalGraph.storage.withTransaction(async (tx) => {
        const outputIdentifier = lookupNodeIdentifier(tx, concreteKey);
        if (outputIdentifier === undefined) {
            return { value: undefined };
        }

        const concreteNode = internalGetOrCreateConcreteNode(
            incrementalGraph,
            concreteKey,
            compiledNode,
            bindings
        );
        const inputIdentifiers = [];
        for (const inputKey of concreteNode.inputs) {
            const inputIdentifier = lookupNodeIdentifier(tx, inputKey);
            if (inputIdentifier === undefined) {
                throw new ReplicaStateInvariantError(
                    "invalidation",
                    `depends on unmaterialized input ${String(inputKey)}`,
                    nodeIdentifierToString(outputIdentifier)
                );
            }
            inputIdentifiers.push(inputIdentifier);
        }
        const inputEdges = normalizeInputEdges(inputIdentifiers);

        tx.batch.freshness.put(outputIdentifier, "potentially-outdated");
        revokeIncomingValidity(tx.batch, outputIdentifier, inputEdges);
        await invalidateDependentsFrom(incrementalGraph.storage, tx.batch, outputIdentifier);

        return { value: undefined };
    });
}


/**
 * @param {IncrementalGraphInvalidateAccess} incrementalGraph
 * @param {string} nodeName
 * @param {Array<ConstValue>} [bindings=[]]
 * @returns {Promise<void>}
 */
async function internalInvalidate(
    incrementalGraph,
    nodeName,
    bindings = []
) {
    return daytimeActivity(incrementalGraph.sleeper, () =>
        internalUnsafeInvalidate(incrementalGraph, nodeName, bindings)
    );
}

module.exports = {
    internalInvalidate,
};
