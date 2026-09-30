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
 * internalUnsafeInvalidate shifts the locking
 * responsibility to the caller (documented by its "unsafe" naming).
 */

/** @typedef {import('./graph_state').BatchBuilder} BatchBuilder */
/** @typedef {import('./graph_state').UserOperation} UserOperation */
/** @typedef {import('./graph_state').Transaction} Transaction */
/** @typedef {import('./types').ComputedValue} ComputedValue */
/** @typedef {import('./types').ConstValue} ConstValue */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */
/** @typedef {import('./database/types').NodeName} NodeName */
/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./types').RecomputeResult} RecomputeResult */
/** @typedef {import('./types').ConcreteNode} ConcreteNode */
/** @typedef {import('./types').ResolvedConcreteNode} ResolvedConcreteNode */
/** @typedef {import('./database/types').NodeKeyString} StoredNodeKeyString */

const { stringToNodeName, nodeIdentifierToString, ReplicaStateInvariantError } = require("./database");
const { stringToNodeKeyString } = require("./database");
const { makeInvalidNodeError } = require("./errors");
const { nighttimeActivity, telescopeActivity } = require("./lock");
const { deserializeNodeKey, serializeNodeKey, txAllocateNodeIdentifier } = require("./database");
const { checkArity, ensureNodeNameIsHead } = require("./shared");
const { internalGetOrCreateConcreteNode } = require("./instantiation");
const { internalMaybeRecalculate } = require("./recompute");
const { lookupNodeIdentifier } = require("./graph_state");

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
 * Read a cached value for an up-to-date node immediately.
 *
 * For an up-to-date node, the stored value is returned directly without
 * checking validity flags. The completeness of validity flags for up-to-date
 * nodes is a storage invariant enforced by writers, migrations, sync merge,
 * and validation, not by the read fast path.
 *
 * A node can only be `up-to-date` if every dependency it validated against
 * still stands. A publication which supersedes a dependency's value occurrence
 * withdraws the proofs that occurrence supported and marks the dependents it
 * left without one potentially outdated, so an `up-to-date` node here is a node
 * whose proof set is current. That is the invariant which lets this path read
 * without consulting validity, and it is what a withdrawal which did not also
 * publish staleness would break.
 *
 * Nodes that are not up-to-date fall through to internalMaybeRecalculate().
 *
 * The read goes through the operation's transaction batch, so it observes the nodes
 * the same operation has already written as well as the committed ones.
 *
 * @param {BatchBuilder} batch
 * @param {NodeIdentifier} nodeIdentifier
 * @returns {Promise<ComputedValue | undefined>}
 */
async function readUpToDateCachedValue(batch, nodeIdentifier) {
    const freshness = await batch.freshness.get(nodeIdentifier);
    const identifierString = nodeIdentifierToString(nodeIdentifier);
    if (freshness === undefined) {
        throw new ReplicaStateInvariantError("pull", "has no freshness entry", identifierString);
    }
    if (freshness !== "up-to-date" && freshness !== "potentially-outdated") {
        throw new ReplicaStateInvariantError("pull", `has invalid freshness ${String(freshness)}`, identifierString);
    }
    if (freshness !== "up-to-date") {
        return undefined;
    }
    const value = await batch.values.get(nodeIdentifier);
    if (value === undefined) {
        throw new ReplicaStateInvariantError("pull", "has no cached value", identifierString);
    }
    return value;
}

/**
 * Core pull implementation for a node by its serialized key, inside the user
 * operation which owns this node's transaction.
 *
 * Returns RecomputeResult for internal use; public pull() extracts the value.
 *
 * @param {IncrementalGraphPullAccess} graph
 * @param {NodeKeyString} nodeKeyStr
 * @param {UserOperation} operation
 * @returns {Promise<RecomputeResult>}
 */
async function pullNodeWithTelescopeHeld(graph, nodeKeyStr, operation) {
    const nodeKey = deserializeNodeKey(stringToNodeKeyString(String(nodeKeyStr)));
    const compiledNode = graph.headIndex.get(nodeKey.head);
    if (!compiledNode) {
        throw makeInvalidNodeError(nodeKey.head);
    }
    checkArity(compiledNode, nodeKey.args);
    const concreteNode = internalGetOrCreateConcreteNode(graph, nodeKeyStr, compiledNode, nodeKey.args);

    const tx = operation.transaction;
    // The transaction's own lookup and batch know about the nodes this operation has
    // already materialized, so a node materialized earlier in the same operation is
    // seen here as the already-materialized node it is.
    const outputIdentifier = lookupNodeIdentifier(tx, nodeKeyStr);
    // An identifier without a cached value is a replica whose sublevels disagree,
    // not a node this operation is materializing for the first time: a fresh
    // materialization has no identifier to begin with.
    const alreadyMaterialized = outputIdentifier !== undefined;
    if (alreadyMaterialized) {
        const cachedValue = await readUpToDateCachedValue(tx.batch, outputIdentifier);
        if (cachedValue !== undefined) {
            return { value: cachedValue, status: "cached" };
        }
    }

    // The operation's transaction captured its schema storage and identifier lookup at
    // the operation's entry (via rootDatabase.getSchemaStorage/getActiveIdentifierLookup).
    // Protected by dome nighttime activity — replica cannot change.
    const transactionOutputIdentifier = outputIdentifier ?? txAllocateNodeIdentifier(
        tx.identifierLookup,
        concreteNode.output,
        () => graph.rootDatabase.generateNodeIdentifier(),
        graph.rootDatabase,
    );
    const outputKey = concreteNode.output;
    const inputKeys = concreteNode.inputs;
    const computor = concreteNode.computor;
    const nodeDefinition = { outputKey, inputKeys, outputIdentifier: transactionOutputIdentifier, computor, alreadyMaterialized };

    // mayRecalculate delegates to internalMaybeRecalculate in recompute.js
    // which runs inside the transaction scope. All awaits inside are
    // protected by dome nighttime activity via the caller.
    const computeResult = await internalMaybeRecalculate(
        graph,
        (nestedNodeKeyStr) => internalPullByNodeKeyDuringPull(graph, nestedNodeKeyStr, operation),
        nodeDefinition,
        tx
    );
    return { value: computeResult.value, status: computeResult.status };
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
 * The call joins that operation's one transaction, so the dependency's writes and
 * their Journal records publish with the operation's, not before it.
 * @param {IncrementalGraphPullAccess} graph
 * @param {NodeKeyString} nodeKeyStr
 * @param {UserOperation} operation
 * @returns {Promise<ComputedValue>}
 */
async function internalPullByNodeKeyDuringPull(graph, nodeKeyStr, operation) {
    const { value } = await telescopeActivity(
        graph.sleeper,
        nodeKeyStr,
        () => pullNodeWithTelescopeHeld(graph, nodeKeyStr, operation)
    );
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
    return nighttimeActivity(graph.sleeper, () => telescopeActivity(
        graph.sleeper,
        nodeKeyStr,
        () => graph.storage.withUserOperation(
            (operation) => pullNodeWithTelescopeHeld(graph, nodeKeyStr, operation)
        )
    ));
}

module.exports = {
    internalPull,
    internalPullByNodeKeyDuringPull,
    internalSafePullWithStatus,
};
