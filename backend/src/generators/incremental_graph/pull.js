/**
 * Pull operations for IncrementalGraph.
 *
 * This module implements the pull logic for computing node values on demand.
 * Transaction context is passed explicitly through the call stack - no
 * async_hooks or global state.
 */

/** @typedef {import('./graph_state').BatchBuilder} BatchBuilder */
/** @typedef {import('./graph_state').Transaction} Transaction */
/** @typedef {import('./types').ComputedValue} ComputedValue */
/** @typedef {import('./types').ConstValue} ConstValue */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */
/** @typedef {import('./types').NodeName} NodeName */
/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./types').RecomputeResult} RecomputeResult */

/**
 * @typedef {object} IncrementalGraphPullAccess
 * @property {Map<NodeName, import('./types').CompiledNode>} headIndex
 * @property {import('../../sleeper').SleepCapability} sleeper
 * @property {import('./graph_state').GraphStorage} storage
 * @property {<T>(procedure: (tx: Transaction) => Promise<T>) => Promise<T>} withTransaction
 * @property {(nodeDefinition: import('./types').ConcreteNode, tx: Transaction) => import('./types').ResolvedConcreteNode} resolveConcreteNode
 * @property {(nodeKeyStr: NodeKeyString, compiledNode: import('./types').CompiledNode, bindings: Array<ConstValue>) => import('./types').ConcreteNode} getOrCreateConcreteNode
 * @property {(nodeDefinition: import('./types').ResolvedConcreteNode, tx: Transaction) => Promise<RecomputeResult>} maybeRecalculate
 * @property {(nodeKeyStr: NodeKeyString, tx: Transaction) => Promise<RecomputeResult>} _pullDuringPull
 * @property {(nodeIdentifier: NodeIdentifier) => import('./types').NodeKeyString | undefined} lookupNodeKey
 */

const { stringToNodeName } = require("./database");
const { stringToNodeKeyString } = require("./database");
const { makeInvalidNodeError } = require("./errors");
const { withPullMode } = require("./lock");
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
    return await internalPullByNodeKeyWithStatusDuringPull(
        incrementalGraph,
        concreteKey,
        null
    );
}

/**
 * Pull a node by semantic key during an active pull context.
 * If tx is provided, uses that transaction. Otherwise starts a new one.
 *
 * @param {IncrementalGraphPullAccess} incrementalGraph
 * @param {NodeKeyString} nodeKeyStr
 * @param {Transaction | null} [tx=null]
 * @returns {Promise<RecomputeResult>}
 */
async function internalPullByNodeKeyWithStatusDuringPull(
    incrementalGraph,
    nodeKeyStr,
    tx = null
) {
    return runPullForSemanticNodeKey(incrementalGraph, nodeKeyStr, tx);
}

/**
 * @param {IncrementalGraphPullAccess} incrementalGraph
 * @param {NodeIdentifier} nodeIdentifier
 * @returns {Promise<RecomputeResult>}
 */
async function internalPullByNodeIdentifierWithStatus(
    incrementalGraph,
    nodeIdentifier
) {
    return withPullMode(incrementalGraph.sleeper, () =>
        internalPullByNodeIdentifierWithStatusDuringPull(
            incrementalGraph,
            nodeIdentifier
        )
    );
}

/**
 * Pull a node by its identifier during an active pull context.
 * This requires looking up the semantic node key from the identifier.
 *
 * @param {IncrementalGraphPullAccess} incrementalGraph
 * @param {NodeIdentifier} nodeIdentifier
 * @returns {Promise<RecomputeResult>}
 */
async function internalPullByNodeIdentifierWithStatusDuringPull(
    incrementalGraph,
    nodeIdentifier
) {
    // Look up the key from the active volatile lookup (lock-free read).
    // The identifier must already be persisted; if not, the pull will fail.
    const nodeKey = incrementalGraph.lookupNodeKey(nodeIdentifier);
    if (nodeKey === undefined) {
        throw new Error(
            `Missing semantic node key for identifier ${String(nodeIdentifier)}: cannot pull by unknown identifier`
        );
    }
    return runPullForSemanticNodeKey(incrementalGraph, nodeKey, null);
}

/**
 * Core pull implementation for a semantic node key.
 * If tx is provided, uses it directly (nested pull case).
 * Otherwise acquires a new transaction (top-level pull case).
 *
 * @param {IncrementalGraphPullAccess} incrementalGraph
 * @param {NodeKeyString} semanticNodeKey
 * @param {Transaction | null} tx
 * @returns {Promise<RecomputeResult>}
 */
async function runPullForSemanticNodeKey(
    incrementalGraph,
    semanticNodeKey,
    tx
) {
    const nodeKey = deserializeNodeKey(stringToNodeKeyString(String(semanticNodeKey)));
    const nodeName = nodeKey.head;
    const bindings = nodeKey.args;
    const compiledNode = incrementalGraph.headIndex.get(nodeName);
    if (!compiledNode) {
        throw makeInvalidNodeError(nodeName);
    }

    checkArity(compiledNode, bindings);

    const concreteNode = incrementalGraph.getOrCreateConcreteNode(
        semanticNodeKey,
        compiledNode,
        bindings
    );

    /**
     * Core computation logic. Runs with a specific transaction.
     * Used for both nested pulls (passing the shared outer tx) and
     * for top-level pulls (passing the tx created inside withTransaction).
     * @param {Transaction} activeTx
     * @returns {Promise<RecomputeResult>}
     */
    const runWithTransaction = async (activeTx) => {
        const nodeDefinition = incrementalGraph.resolveConcreteNode(
            concreteNode,
            activeTx
        );
        const outputIdentifier = nodeDefinition.outputIdentifier;
        const nodeFreshness = await activeTx.batch.freshness.get(outputIdentifier);

        if (nodeFreshness === "up-to-date") {
            const result = await activeTx.batch.values.get(outputIdentifier);
            if (result === undefined) {
                throw new Error(
                    `Impossible: up-to-date node has no stored value: ${String(semanticNodeKey)}`
                );
            }
            return { value: result, status: "cached" };
        }

        return await incrementalGraph.maybeRecalculate(nodeDefinition, activeTx);
    };

    if (tx !== null) {
        // Nested call: the outer pull already holds withComputedStateMutex and has
        // created the transaction. Running withTransaction here would deadlock
        // on the same computed-state mutex.
        // Instead, execute directly with the shared tx — the outer pull's commit
        // covers all identifier allocations and node-data writes for the entire tree.
        return runWithTransaction(tx);
    }

    // Top-level pull: acquire the computed-state lock and create a fresh
    // transaction inside the critical section.
    return incrementalGraph.withTransaction((freshTx) =>
        runWithTransaction(freshTx)
    );
}

module.exports = {
    internalPull,
    internalPullByNodeKeyWithStatusDuringPull,
    internalPullByNodeIdentifierWithStatusDuringPull,
    internalPullByNodeIdentifierWithStatus,
    internalSafePullWithStatus,
    internalPullWithStatus,
    internalUnsafePull,
};
