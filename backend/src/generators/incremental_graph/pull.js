/**
 * Pull operations for IncrementalGraph.
 *
 * Each pull creates its own Transaction — no shared Transaction context
 * between top-level and nested pulls. The old cross-transaction dedup
 * cache (nodePulls) and importSharedResolution are removed.
 *
 * pull() always returns ComputedValue (not RecomputeResult).
 */

/** @typedef {import('./graph_state').BatchBuilder} BatchBuilder */
/** @typedef {import('./graph_state').Transaction} Transaction */
/** @typedef {import('./types').ComputedValue} ComputedValue */
/** @typedef {import('./types').ConstValue} ConstValue */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */
/** @typedef {import('./database/types').NodeName} NodeName */
/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./types').RecomputeResult} RecomputeResult */
/** @typedef {import('./types').ResolvedConcreteNode} ResolvedConcreteNode */
/** @typedef {import('./database/types').NodeKeyString} StoredNodeKeyString */

const { stringToNodeName } = require("./database");
const { stringToNodeKeyString } = require("./database");
const { makeInvalidNodeError } = require("./errors");
const { withPullMode, withPullNodeMutex } = require("./lock");
const { deserializeNodeKey, serializeNodeKey } = require("./database");
const { checkArity, ensureNodeNameIsHead } = require("./shared");

/**
 * @typedef {object} IncrementalGraphPullAccess
 * @property {Map<NodeName, import('./types').CompiledNode>} headIndex
 * @property {import('../../sleeper').SleepCapability} sleeper
 * @property {import('./graph_state').GraphStorage} storage
 * @property {import('./database/root_database').RootDatabase} rootDatabase
 * @property {<T>(procedure: (tx: Transaction) => Promise<{value: T, revdepDiffs?: Array<import('./graph_state').RevdepDiff>}>) => Promise<T>} withTransaction
 * @property {(nodeKey: NodeKeyString) => NodeIdentifier | undefined} lookupNodeIdentifier
 * @property {(nodeDefinition: import('./types').ConcreteNode, tx: Transaction) => Promise<ResolvedConcreteNode>} resolveConcreteNode
 * @property {(nodeKeyStr: NodeKeyString, compiledNode: import('./types').CompiledNode, bindings: Array<ConstValue>) => import('./types').ConcreteNode} getOrCreateConcreteNode
 * @property {(nodeDefinition: ResolvedConcreteNode, tx: Transaction, reportRevdepDiff: (diff: import('./graph_state').RevdepDiff) => void) => Promise<RecomputeResult>} maybeRecalculate
 */

/**
 * Core pull implementation for a node by its serialized key.
 * Always creates its own Transaction — no shared Transaction context.
 *
 * Returns RecomputeResult for internal use; public pull() extracts the value.
 *
 * @param {IncrementalGraphPullAccess} graph
 * @param {NodeKeyString} nodeKeyStr
 * @returns {Promise<RecomputeResult>}
 */
async function pullNode(graph, nodeKeyStr) {
    return withPullNodeMutex(graph.sleeper, String(nodeKeyStr), async () => {
        const nodeKey = deserializeNodeKey(stringToNodeKeyString(String(nodeKeyStr)));
        const compiledNode = graph.headIndex.get(nodeKey.head);
        if (!compiledNode) {
            throw makeInvalidNodeError(nodeKey.head);
        }
        checkArity(compiledNode, nodeKey.args);
        const concreteNode = graph.getOrCreateConcreteNode(nodeKeyStr, compiledNode, nodeKey.args);

        // Early freshness check against committed storage — no Transaction needed.
        const committedIdentifier = graph.lookupNodeIdentifier(nodeKeyStr);
        if (committedIdentifier !== undefined) {
            const nodeFreshness = await graph.storage.freshness.get(committedIdentifier);
            if (nodeFreshness === "up-to-date") {
                const result = await graph.storage.values.get(committedIdentifier);
                if (result !== undefined) {
                    return { value: result, status: "cached" };
                }
                throw new Error(
                    `Impossible: up-to-date node has no stored value (committed): ${String(nodeKeyStr)}`
                );
            }
        }

        // Full computation with its own Transaction
        const result = await graph.withTransaction(async (tx) => {
            const nodeDefinition = await graph.resolveConcreteNode(
                concreteNode,
                tx,
            );

            /** @type {Array<import('./graph_state').RevdepDiff>} */
            const revdepDiffs = [];

            const nodeFreshness = await tx.batch.freshness.get(nodeDefinition.outputIdentifier);
            if (nodeFreshness === "up-to-date") {
                const storedValue = await tx.batch.values.get(nodeDefinition.outputIdentifier);
                if (storedValue !== undefined) {
                    /** @type {RecomputeResult} */
                    const cachedResult = { value: storedValue, status: "cached" };
                    return {
                        value: cachedResult,
                        revdepDiffs,
                    };
                }
                throw new Error(
                    `Impossible: up-to-date node has no stored value: ${String(nodeKeyStr)}`
                );
            }

            const computeResult = await graph.maybeRecalculate(
                nodeDefinition,
                tx,
                (diff) => revdepDiffs.push(diff)
            );

            const counter = await tx.batch.counters.get(nodeDefinition.outputIdentifier);
            if (counter === undefined) {
                throw new Error(
                    `Impossible: recomputed node has no stored counter: ${String(nodeKeyStr)}`
                );
            }

            return {
                value: computeResult,
                revdepDiffs,
            };
        });
        return result;
    });
}

/**
 * Top-level pull. Acquires the pull-mode lock.
 * @param {IncrementalGraphPullAccess} graph
 * @param {string} nodeName
 * @param {Array<ConstValue>} [bindings=[]]
 * @returns {Promise<ComputedValue>}
 */
async function internalPull(graph, nodeName, bindings = []) {
    ensureNodeNameIsHead(nodeName);
    const { value } = await internalSafePullWithStatus(graph, nodeName, bindings);
    return value;
}

/**
 * Pull by serialized key during an existing pull operation.
 * Each call creates its own Transaction — no Transaction sharing.
 * @param {IncrementalGraphPullAccess} graph
 * @param {NodeKeyString} nodeKeyStr
 * @returns {Promise<ComputedValue>}
 */
async function internalPullByNodeKeyDuringPull(graph, nodeKeyStr) {
    const { value } = await pullNode(graph, nodeKeyStr);
    return value;
}

/**
 * Top-level pull with status. Acquires the pull-mode lock.
 * @param {IncrementalGraphPullAccess} graph
 * @param {string} nodeName
 * @param {Array<ConstValue>} [bindings=[]]
 * @returns {Promise<RecomputeResult>}
 */
async function internalSafePullWithStatus(graph, nodeName, bindings = []) {
    ensureNodeNameIsHead(nodeName);
    return withPullMode(graph.sleeper, () => {
        const nodeKeyStr = serializeNodeKey({ head: stringToNodeName(nodeName), args: bindings });
        return pullNode(graph, nodeKeyStr);
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
    const { value } = await pullNode(graph, nodeKeyStr);
    return value;
}

module.exports = {
    internalPull,
    internalPullByNodeKeyDuringPull,
    internalSafePullWithStatus,
    internalUnsafePull,
};
