/**
 * IncrementalGraph class for propagating data through dependency edges.
 */

/** @typedef {import('./database/root_database').RootDatabase} RootDatabase */
/** @typedef {import('./types').NodeDef} NodeDef */
/** @typedef {import('./types').CompiledNode} CompiledNode */
/** @typedef {import('./types').ConcreteNode} ConcreteNode */
/** @typedef {import('./types').ConstValue} ConstValue */
/** @typedef {import('./types').ComputedValue} ComputedValue */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */
/** @typedef {import('./types').RecomputeResult} RecomputeResult */
/** @typedef {import('./graph_storage').GraphStorage} GraphStorage */
/** @typedef {import('./graph_storage').BatchBuilder} BatchBuilder */
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
const { makeGraphStorage } = require("./graph_storage");
const {
    internalDebugGetDbVersion,
    internalDebugGetFreshness,
    internalDebugGetSchemaByHead,
    internalDebugGetSchemas,
    internalDebugGetValue,
    internalDebugListMaterializedNodes,
    internalGetCreationTime,
    internalGetModificationTime,
    internalGetCreator,
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
    internalPullByNodeKeyStringWithStatus,
    internalPullWithStatus,
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

    /** @type {import('../../environment').Environment} */
    environment;

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

        this.storage = makeGraphStorage(rootDatabase);
        this.dbVersion = rootDatabase.version;
        this.headIndex = new Map();
        for (const compiledNode of compiledNodes) {
            this.headIndex.set(compiledNode.head, compiledNode);
        }

        this.concreteInstantiations = makeConcreteNodeCache();
        this.sleeper = capabilities.sleeper;
        this.datetime = capabilities.datetime;
        this.environment = capabilities.environment;
    }

    /**
     * @param {NodeKeyString} changedKey
     * @param {BatchBuilder} batch
     * @param {Set<NodeKeyString>} [nodesBecomingOutdated]
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
     * @param {NodeKeyString} concreteKeyCanonical
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
     * @param {ConcreteNode} nodeDefinition
     * @param {BatchBuilder} batch
     * @returns {Promise<RecomputeResult>}
     */
    async maybeRecalculate(nodeDefinition, batch) {
        return await internalMaybeRecalculate(this, nodeDefinition, batch);
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
        return await internalPullWithStatus(this, nodeName, bindings);
    }

    /**
     * @param {NodeKeyString} nodeKeyStr
     * @returns {Promise<RecomputeResult>}
     */
    async pullByNodeKeyStringWithStatus(nodeKeyStr) {
        return await internalPullByNodeKeyStringWithStatus(this, nodeKeyStr);
    }

    /**
     * @param {string} head
     * @param {Array<ConstValue>} [bindings=[]]
     * @returns {Promise<"up-to-date" | "potentially-outdated" | "missing">}
     */
    async debugGetFreshness(head, bindings = []) {
        return await internalDebugGetFreshness(this, head, bindings);
    }

    /**
     * @param {string} head
     * @param {Array<ConstValue>} [bindings=[]]
     * @returns {Promise<ComputedValue | undefined>}
     */
    async debugGetValue(head, bindings = []) {
        return await internalDebugGetValue(this, head, bindings);
    }

    /** @returns {Array<CompiledNode>} */
    debugGetSchemas() {
        return internalDebugGetSchemas(this);
    }

    /**
     * @param {string} head
     * @returns {CompiledNode | null}
     */
    debugGetSchemaByHead(head) {
        return internalDebugGetSchemaByHead(this, head);
    }

    /** @returns {Promise<Array<[string, Array<ConstValue>]>>} */
    async debugListMaterializedNodes() {
        return await internalDebugListMaterializedNodes(this);
    }

    /** @returns {string} */
    debugGetDbVersion() {
        return internalDebugGetDbVersion(this);
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

    /**
     * @param {string} nodeName
     * @param {Array<ConstValue>} [bindings=[]]
     * @returns {Promise<string>}
     */
    async getCreator(nodeName, bindings = []) {
        return await internalGetCreator(this, nodeName, bindings);
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
