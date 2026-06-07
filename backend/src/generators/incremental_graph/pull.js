/**
 * Pull operations for IncrementalGraph.
 *
 * Each pull creates its own Transaction and submits its batch independently.
 * Top-level pulls and nested dependency pulls are structurally identical —
 * every call to pullNode creates a fresh Transaction with its own batch.
 * There is no shared Transaction context between caller and callee.
 *
 * Each nested pull commits its results as soon as it finishes, before the
 * parent continues. This means a dependency's writes are visible on disk
 * even if a later parent computor fails.
 *
 * pull() always returns ComputedValue (not RecomputeResult).
 *
 * Async-boundary safety:
 * Every `await` in this module is protected by the dome nighttime activity lock
 * (acquired by nighttimeActivity + telescopeActivity).
 * This prevents any concurrent setCurrentReplicaPointer (which needs
 * with holidayActivity on the same key).  GraphStorage getters
 * (graph.storage.freshness, graph.storage.values, etc.) call
 * rootDatabase.getSchemaStorage() at each access, so property access chains
 * like `graph.storage.freshness.get(key)` always resolve against the
 * currently active replica — no captured reference survives across await
 * unless the lock guarantees the replica cannot change.
 * internalUnsafePull and internalUnsafeInvalidate shift the locking
 * responsibility to the caller (documented by their "unsafe" names).
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
const { nighttimeActivity, telescopeActivity } = require("./lock");
const { deserializeNodeKey, serializeNodeKey, txAllocateNodeIdentifier } = require("./database");
const { checkArity, ensureNodeNameIsHead } = require("./shared");
const { internalGetOrCreateConcreteNode } = require("./instantiation");
const { internalMaybeRecalculate } = require("./recompute");

/**
 * @typedef {object} IncrementalGraphPullAccess
 * @property {Map<NodeName, import('./types').CompiledNode>} headIndex
 * @property {import('../../sleeper').SleepCapability} sleeper
 * @property {import('./graph_state').GraphStorage} storage
 * @property {import('./database/root_database').RootDatabase} rootDatabase
 * @property {import('./lru_cache').ConcreteNodeCache} concreteInstantiations
 * @property {import('../../datetime').Datetime} datetime
 */

/**
 * Core pull implementation for a node by its serialized key.
 * Creates its own Transaction and submits its batch independently.
 *
 * Returns RecomputeResult for internal use; public pull() extracts the value.
 *
 * @param {IncrementalGraphPullAccess} graph
 * @param {NodeKeyString} nodeKeyStr
 * @returns {Promise<RecomputeResult>}
 */
async function pullNodeWithTelescopeHeld(graph, nodeKeyStr) {
    const nodeKey = deserializeNodeKey(stringToNodeKeyString(String(nodeKeyStr)));
    const compiledNode = graph.headIndex.get(nodeKey.head);
    if (!compiledNode) {
        throw makeInvalidNodeError(nodeKey.head);
    }
    checkArity(compiledNode, nodeKey.args);
    const concreteNode = internalGetOrCreateConcreteNode(graph, nodeKeyStr, compiledNode, nodeKey.args);

        // Early freshness check against committed storage — no Transaction needed.
        // await sites below: graph.storage.freshness and .values are getters that
        // call rootDatabase.getSchemaStorage() at each access.
        // Protected by dome nighttime activity — no concurrent replica switch.
        const committedIdentifier = graph.rootDatabase.nodeKeyToId(nodeKeyStr);
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

        // storage.withTransaction captures fresh schemaStorage + identifierLookup
        // at entry (via rootDatabase.getSchemaStorage/getActiveIdentifierLookup).
        // Protected by dome nighttime activity — replica cannot change.
    const result = await graph.storage.withTransaction(async (tx) => {
            const outputIdentifier = txAllocateNodeIdentifier(
                tx.identifierLookup,
                concreteNode.output,
                () => graph.rootDatabase.generateNodeIdentifier(),
                graph.rootDatabase,
            );
            const outputKey = concreteNode.output;
            const inputKeys = concreteNode.inputs;
            const computor = concreteNode.computor;
            const nodeDefinition = { outputKey, inputKeys, outputIdentifier, computor };

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

            // mayRecalculate delegates to internalMaybeRecalculate in recompute.js
            // which runs inside the transaction scope. All awaits inside are
            // protected by dome nighttime activity via the caller.
            const computeResult = await internalMaybeRecalculate(
                graph,
                (nodeKeyStr) => internalPullByNodeKeyDuringPull(graph, nodeKeyStr),
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
    const { value } = await telescopeActivity(graph.sleeper, nodeKeyStr, () => pullNodeWithTelescopeHeld(graph, nodeKeyStr));
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
    const nodeKeyStr = serializeNodeKey({ head: stringToNodeName(nodeName), args: bindings });
    return nighttimeActivity(graph.sleeper, () => telescopeActivity(graph.sleeper, nodeKeyStr, () => pullNodeWithTelescopeHeld(graph, nodeKeyStr)));
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
    const { value } = await telescopeActivity(graph.sleeper, nodeKeyStr, () => pullNodeWithTelescopeHeld(graph, nodeKeyStr));
    return value;
}

module.exports = {
    internalPull,
    internalPullByNodeKeyDuringPull,
    internalSafePullWithStatus,
    internalUnsafePull,
};
