/**
 * IncrementalGraph class for propagating data through dependency edges.
 *
 * This implementation follows the transaction model specified in:
 * docs/specs/incremental-graph-volatile-consistency.md
 *
 * Key principles:
 * - Explicit over ambient: Transaction context is passed as a direct function argument
 * - No global state, no async_hooks
 * - Disk before memory: in-memory state is updated only after LevelDB batch flushes
 */

/** @typedef {import('./database/root_database').RootDatabase} RootDatabase */
/** @typedef {import('./types').NodeDef} NodeDef */
/** @typedef {import('./types').CompiledNode} CompiledNode */
/** @typedef {import('./types').ConcreteNode} ConcreteNode */
/** @typedef {import('./types').ResolvedConcreteNode} ResolvedConcreteNode */
/** @typedef {import('./types').ConstValue} ConstValue */
/** @typedef {import('./types').ComputedValue} ComputedValue */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */
/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./types').RecomputeResult} RecomputeResult */
/** @typedef {import('./graph_state').GraphStorage} GraphStorage */
/** @typedef {import('./graph_state').BatchBuilder} BatchBuilder */
/** @typedef {import('./graph_state').Transaction} Transaction */
/** @typedef {import('./lru_cache').ConcreteNodeCache} ConcreteNodeCache */
/** @typedef {import('../../datetime').DateTime} DateTime */
/** @typedef {import('../../datetime').Datetime} Datetime */
/** @typedef {import('../../sleeper').SleepCapability} SleepCapability */
/** @typedef {import('./types').IncrementalGraphCapabilities} IncrementalGraphCapabilities */

const {
    compileNodeDef,
    validateAcyclic,
    validateInputArities,
    validateNoOverlap,
    validateSingleArityPerHead,
} = require("./compiled_node");
const { makeGraphStorage, getOrAllocateNodeIdentifier } = require("./graph_state");
const {
    internalGetDbVersion,
    internalGetFreshness,
    internalGetSchemaByHead,
    internalGetSchemas,
    internalGetValue,
    internalListMaterializedNodes,
    internalGetCreationTime,
    internalGetModificationTime,
} = require("./inspection");
const {
    internalInvalidate,
    internalPropagateOutdated,
    internalUnsafeInvalidate,
} = require("./invalidate");
const { internalGetOrCreateConcreteNode } = require("./instantiation");
const { makeConcreteNodeCache } = require("./lru_cache");
const {
    internalPull,
    internalPullByNodeKeyWithStatusDuringPull,
    internalSafePullWithStatus,
    internalUnsafePull,
} = require("./pull");
const { internalMaybeRecalculate } = require("./recompute");

class IncrementalGraphClass {
    /** @type {Map<import('./types').NodeName, CompiledNode>} */
    headIndex;

    /** @type {ConcreteNodeCache} */
    concreteInstantiations;

    /** @type {GraphStorage} */
    storage;

    /** @type {import('./types').Version} */
    dbVersion;

    /** @type {SleepCapability} */
    sleeper;

    /** @type {Datetime} */
    datetime;

    /** @type {RootDatabase} */
    rootDatabase;

    /**
     * @param {IncrementalGraphCapabilities} capabilities
     * @param {RootDatabase} rootDatabase
     * @param {Array<NodeDef>} nodeDefs
     */
    constructor(capabilities, rootDatabase, nodeDefs) {
        const compiledNodes = nodeDefs.map(compileNodeDef);
        validateNoOverlap(compiledNodes);
        validateAcyclic(compiledNodes);
        validateSingleArityPerHead(compiledNodes);
        validateInputArities(compiledNodes);

        this.storage = makeGraphStorage(rootDatabase, capabilities.sleeper);
        this.rootDatabase = rootDatabase;
        this.dbVersion = rootDatabase.version;
        this.headIndex = new Map();
        for (const compiledNode of compiledNodes) {
            this.headIndex.set(compiledNode.head, compiledNode);
        }

        this.concreteInstantiations = makeConcreteNodeCache();
        this.sleeper = capabilities.sleeper;
        this.datetime = capabilities.datetime;
    }

    /**
     * @param {import('./types').NodeIdentifier} changedKey
     * @param {BatchBuilder} batch
     * @param {Set<string>} [nodesBecomingOutdated]
     * @returns {Promise<void>}
     */
    async propagateOutdated(changedKey, batch, nodesBecomingOutdated = new Set()) {
        await internalPropagateOutdated(
            this,
            changedKey,
            batch,
            nodesBecomingOutdated
        );
    }

    /**
     * @param {string} nodeName
     * @param {Array<ConstValue>} bindings
     * @returns {Promise<void>}
     */
    async unsafeInvalidate(nodeName, bindings) {
        await internalUnsafeInvalidate(this, nodeName, bindings);
    }

    /**
     * @param {string} nodeName
     * @param {Array<ConstValue>} [bindings=[]]
     * @returns {Promise<void>}
     */
    async invalidate(nodeName, bindings = []) {
        await internalInvalidate(this, nodeName, bindings);
    }

    /**
     * @param {import('./types').NodeKeyString} concreteKeyCanonical
     * @param {CompiledNode} compiledNode
     * @param {Array<ConstValue>} bindings
     * @returns {ConcreteNode}
     */
    getOrCreateConcreteNode(concreteKeyCanonical, compiledNode, bindings) {
        return internalGetOrCreateConcreteNode(
            this,
            concreteKeyCanonical,
            compiledNode,
            bindings
        );
    }

    /**
     * Look up the semantic node key for a given identifier.
     * This is a lock-free read from the active in-memory lookup.
     * @param {NodeIdentifier} nodeIdentifier
     * @returns {import('./types').NodeKeyString | undefined}
     */
    lookupNodeKey(nodeIdentifier) {
        return this.rootDatabase.nodeIdToKey(nodeIdentifier);
    }

    /**
     * Look up the identifier for a given semantic node key.
     * This is a lock-free read from the active in-memory lookup.
     * @param {import('./types').NodeKeyString} nodeKey
     * @returns {NodeIdentifier | undefined}
     */
    lookupNodeIdentifier(nodeKey) {
        return this.rootDatabase.nodeKeyToId(nodeKey);
    }

    /**
     * Execute a procedure within a transaction that provides a batch writer
     * and identifier lookup. The batch is flushed and in-memory state updated
     * only if the procedure succeeds.
     *
     * @template T
     * @param {(tx: Transaction) => Promise<T>} procedure
     * @returns {Promise<T>}
     */
    async withTransaction(procedure) {
        return this.storage.withTransaction(procedure);
    }

    /**
     * @param {ConcreteNode} concreteNode
     * @param {Transaction} tx
     * @param {boolean} [allocateInputs=true]
     * @returns {ResolvedConcreteNode}
     */
    resolveConcreteNode(concreteNode, tx, allocateInputs = true) {
        return {
            outputKey: concreteNode.output,
            inputKeys: concreteNode.inputs,
            outputIdentifier: getOrAllocateNodeIdentifier(
                tx,
                this.rootDatabase,
                concreteNode.output
            ),
            inputIdentifiers: allocateInputs
                ? concreteNode.inputs.map((inputKey) =>
                    getOrAllocateNodeIdentifier(tx, this.rootDatabase, inputKey)
                )
                : [],
            computor: concreteNode.computor,
        };
    }

    /**
     * @param {ResolvedConcreteNode} nodeDefinition
     * @param {Transaction} tx
     * @returns {Promise<RecomputeResult>}
     */
    async maybeRecalculate(nodeDefinition, tx) {
        return await internalMaybeRecalculate(this, nodeDefinition, tx);
    }

    /**
     * @param {string} nodeName
     * @param {Array<ConstValue>} bindings
     * @returns {Promise<ComputedValue>}
     */
    async unsafePull(nodeName, bindings) {
        return await internalUnsafePull(this, nodeName, bindings);
    }

    /**
     * @param {string} nodeName
     * @param {Array<ConstValue>} [bindings=[]]
     * @returns {Promise<ComputedValue>}
     */
    async pull(nodeName, bindings = []) {
        return await internalPull(this, nodeName, bindings);
    }

    /**
     * @param {import('./types').NodeName} nodeName
     * @param {Array<ConstValue>} [bindings=[]]
     * @returns {Promise<RecomputeResult>}
     */
    async pullWithStatus(nodeName, bindings = []) {
        return await internalSafePullWithStatus(this, nodeName, bindings);
    }

    /**
     * Internal method for pulling a node during an existing pull operation.
     * The transaction context is passed explicitly to share the batch and lookup.
     *
     * @param {NodeKeyString} nodeKeyStr
     * @param {Transaction} tx
     * @returns {Promise<RecomputeResult>}
     */
    async _pullDuringPull(nodeKeyStr, tx) {
        return await internalPullByNodeKeyWithStatusDuringPull(
            this,
            nodeKeyStr,
            tx
        );
    }

    /**
     * @param {string} head
     * @param {Array<ConstValue>} [bindings=[]]
     * @returns {Promise<"up-to-date" | "potentially-outdated" | "missing">}
     */
    async getFreshness(head, bindings = []) {
        return await internalGetFreshness(this, head, bindings);
    }

    /**
     * @param {string} head
     * @param {Array<ConstValue>} [bindings=[]]
     * @returns {Promise<ComputedValue | undefined>}
     */
    async getValue(head, bindings = []) {
        return await internalGetValue(this, head, bindings);
    }

    /** @returns {Array<CompiledNode>} */
    getSchemas() {
        return internalGetSchemas(this);
    }

    /**
     * @param {string} head
     * @returns {CompiledNode | null}
     */
    getSchemaByHead(head) {
        return internalGetSchemaByHead(this, head);
    }

    /** @returns {Promise<Array<[string, Array<ConstValue>]>>} */
    async listMaterializedNodes() {
        return await internalListMaterializedNodes(this);
    }

    /** @returns {string} */
    getDbVersion() {
        return internalGetDbVersion(this);
    }

    /**
     * @param {string} nodeName
     * @param {Array<ConstValue>} [bindings=[]]
     * @returns {Promise<DateTime>}
     */
    async getCreationTime(nodeName, bindings = []) {
        return await internalGetCreationTime(this, nodeName, bindings);
    }

    /**
     * @param {string} nodeName
     * @param {Array<ConstValue>} [bindings=[]]
     * @returns {Promise<DateTime>}
     */
    async getModificationTime(nodeName, bindings = []) {
        return await internalGetModificationTime(this, nodeName, bindings);
    }
}

/**
 * @param {IncrementalGraphCapabilities} capabilities
 * @param {RootDatabase} rootDatabase
 * @param {Array<NodeDef>} nodeDefs
 * @returns {IncrementalGraphClass}
 */
function makeIncrementalGraph(capabilities, rootDatabase, nodeDefs) {
    return new IncrementalGraphClass(capabilities, rootDatabase, nodeDefs);
}

/**
 * @param {unknown} object
 * @returns {object is IncrementalGraphClass}
 */
function isIncrementalGraph(object) {
    return object instanceof IncrementalGraphClass;
}

/** @typedef {IncrementalGraphClass} IncrementalGraph */

module.exports = {
    makeIncrementalGraph,
    isIncrementalGraph,
};
