/**
 * Pull operations for IncrementalGraph.
 *
 * Transaction context is passed explicitly through the call stack - no
 * async_hooks or global state.
 *
 * The spec defines two pull paths:
 * - Top-level pull: creates a transaction via withTransaction, runs pullNode inside it.
 * - Nested pull: reuses the outer transaction directly (no new mutex acquisition).
 *
 * Both paths go through pullNode(graph, nodeKeyStr, tx): tx=null means top-level.
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
 */

const { stringToNodeName } = require("./database");
const { stringToNodeKeyString } = require("./database");
const { makeInvalidNodeError } = require("./errors");
const { withPullMode } = require("./lock");
const { deserializeNodeKey, serializeNodeKey } = require("./database");
const { checkArity, ensureNodeNameIsHead } = require("./shared");

/**
 * Core pull implementation for a node by its serialized key.
 * - If tx is non-null (nested pull): uses it directly — the outer pull's commit covers all writes.
 * - If tx is null (top-level pull): acquires a fresh transaction via withTransaction.
 *
 * @param {IncrementalGraphPullAccess} graph
 * @param {NodeKeyString} nodeKeyStr
 * @param {Transaction | null} tx
 * @returns {Promise<RecomputeResult>}
 */
async function pullNode(graph, nodeKeyStr, tx) {
    const nodeKey = deserializeNodeKey(stringToNodeKeyString(String(nodeKeyStr)));
    const compiledNode = graph.headIndex.get(nodeKey.head);
    if (!compiledNode) {
        throw makeInvalidNodeError(nodeKey.head);
    }
    checkArity(compiledNode, nodeKey.args);
    const concreteNode = graph.getOrCreateConcreteNode(nodeKeyStr, compiledNode, nodeKey.args);

    /**
     * Checks freshness: returns cached value if up-to-date,
     * otherwise delegates to maybeRecalculate.
     * @param {Transaction} activeTx
     * @returns {Promise<RecomputeResult>}
     */
    const runWithTransaction = async (activeTx) => {
        const nodeDefinition = graph.resolveConcreteNode(concreteNode, activeTx);
        const nodeFreshness = await activeTx.batch.freshness.get(nodeDefinition.outputIdentifier);

        if (nodeFreshness === "up-to-date") {
            const result = await activeTx.batch.values.get(nodeDefinition.outputIdentifier);
            if (result === undefined) {
                throw new Error(
                    `Impossible: up-to-date node has no stored value: ${String(nodeKeyStr)}`
                );
            }
            return { value: result, status: "cached" };
        }

        return graph.maybeRecalculate(nodeDefinition, activeTx);
    };

    /**
     * Deduplicate in-flight pulls of the same node key within one transaction.
     * @param {Transaction} activeTx
     * @returns {Promise<RecomputeResult>}
     */
    const runDeduplicatedInTransaction = (activeTx) => {
        const existing = activeTx.inFlight.get(nodeKeyStr);
        if (existing !== undefined) {
            return existing;
        }
        const promise = runWithTransaction(activeTx).finally(() => {
            activeTx.inFlight.delete(nodeKeyStr);
        });
        activeTx.inFlight.set(nodeKeyStr, promise);
        return promise;
    };

    if (tx !== null) {
        // Nested call: outer pull already holds the computed-state mutex.
        // Share the outer transaction directly to avoid deadlock.
        return runDeduplicatedInTransaction(tx);
    }

    // Top-level pull: acquire the computed-state lock and create a fresh transaction.
    return graph.withTransaction(async (activeTx) => runDeduplicatedInTransaction(activeTx));
}

/**
 * Top-level pull. Acquires the pull-mode lock.
 * @param {IncrementalGraphPullAccess} graph
 * @param {string} nodeName
 * @param {Array<ConstValue>} [bindings=[]]
 * @returns {Promise<ComputedValue>}
 */
async function internalPull(graph, nodeName, bindings = []) {
    return withPullMode(graph.sleeper, async () => {
        ensureNodeNameIsHead(nodeName);
        const nodeKeyStr = serializeNodeKey({ head: stringToNodeName(nodeName), args: bindings });
        const { value } = await pullNode(graph, nodeKeyStr, null);
        return value;
    });
}

/**
 * Top-level pull with status. Acquires the pull-mode lock.
 * @param {IncrementalGraphPullAccess} graph
 * @param {NodeName} nodeName
 * @param {Array<ConstValue>} [bindings=[]]
 * @returns {Promise<RecomputeResult>}
 */
async function internalSafePullWithStatus(graph, nodeName, bindings = []) {
    return withPullMode(graph.sleeper, () => {
        const nodeKeyStr = serializeNodeKey({ head: nodeName, args: bindings });
        return pullNode(graph, nodeKeyStr, null);
    });
}

/**
 * Unsafe pull — caller must already hold the pull-mode lock.
 * @param {IncrementalGraphPullAccess} graph
 * @param {string} nodeName
 * @param {Array<ConstValue>} bindings
 * @returns {Promise<ComputedValue>}
 */
async function internalUnsafePull(graph, nodeName, bindings) {
    ensureNodeNameIsHead(nodeName);
    const nodeKeyStr = serializeNodeKey({ head: stringToNodeName(nodeName), args: bindings });
    const { value } = await pullNode(graph, nodeKeyStr, null);
    return value;
}

/**
 * Nested pull by serialized key — uses the existing transaction, no new mutex.
 * Called from computors (via _pullDuringPull) and from recompute.js.
 * @param {IncrementalGraphPullAccess} graph
 * @param {NodeKeyString} nodeKeyStr
 * @param {Transaction | null} tx
 * @returns {Promise<RecomputeResult>}
 */
async function internalPullByNodeKeyWithStatusDuringPull(graph, nodeKeyStr, tx) {
    return pullNode(graph, nodeKeyStr, tx);
}

module.exports = {
    internalPull,
    internalPullByNodeKeyWithStatusDuringPull,
    internalSafePullWithStatus,
    internalUnsafePull,
};
