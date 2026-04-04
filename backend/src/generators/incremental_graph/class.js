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
const { stringToNodeName } = require("./database");
const { makeInvalidNodeError } = require("./errors");
const { makeGraphStorage } = require("./graph_storage");
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
    internalPullByNodeKeyStringWithStatusDuringPull,
    internalPullByNodeKeyStringWithStatus,
    internalSafePullWithStatus,
    internalUnsafePull,
} = require("./pull");
const { internalMaybeRecalculate } = require("./recompute");
const { bindingsMapToPositional, positionalToBindingsMap } = require("./shared");

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
     * @param {Record<string, ConstValue>} bindings
     * @returns {Promise<void>}
     */
    async unsafeInvalidate(nodeName, bindings) {
        const nodeNameTyped = stringToNodeName(nodeName);
        const compiledNode = this.headIndex.get(nodeNameTyped);
        if (!compiledNode) throw makeInvalidNodeError(nodeNameTyped);
        const positionalBindings = bindingsMapToPositional(compiledNode, bindings);
        await internalUnsafeInvalidate(this, nodeName, positionalBindings);
    }

    /**
     * @param {string} nodeName
     * @param {Record<string, ConstValue>} [bindings={}]
     * @returns {Promise<void>}
     */
    async invalidate(nodeName, bindings = {}) {
        const nodeNameTyped = stringToNodeName(nodeName);
        const compiledNode = this.headIndex.get(nodeNameTyped);
        if (!compiledNode) throw makeInvalidNodeError(nodeNameTyped);
        const positionalBindings = bindingsMapToPositional(compiledNode, bindings);
        await internalInvalidate(this, nodeName, positionalBindings);
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
     * @param {Record<string, ConstValue>} bindings
     * @returns {Promise<ComputedValue>}
     */
    async unsafePull(nodeName, bindings) {
        const nodeNameTyped = stringToNodeName(nodeName);
        const compiledNode = this.headIndex.get(nodeNameTyped);
        if (!compiledNode) throw makeInvalidNodeError(nodeNameTyped);
        const positionalBindings = bindingsMapToPositional(compiledNode, bindings);
        return await internalUnsafePull(this, nodeName, positionalBindings);
    }

    /**
     * @param {string} nodeName
     * @param {Record<string, ConstValue>} [bindings={}]
     * @returns {Promise<ComputedValue>}
     */
    async pull(nodeName, bindings = {}) {
        const nodeNameTyped = stringToNodeName(nodeName);
        const compiledNode = this.headIndex.get(nodeNameTyped);
        if (!compiledNode) throw makeInvalidNodeError(nodeNameTyped);
        const positionalBindings = bindingsMapToPositional(compiledNode, bindings);
        return await internalPull(this, nodeName, positionalBindings);
    }

    /**
     * @param {import('./types').NodeName} nodeName
     * @param {Record<string, ConstValue>} [bindings={}]
     * @returns {Promise<RecomputeResult>}
     */
    async pullWithStatus(nodeName, bindings = {}) {
        const compiledNode = this.headIndex.get(nodeName);
        if (!compiledNode) throw makeInvalidNodeError(nodeName);
        const positionalBindings = bindingsMapToPositional(compiledNode, bindings);
        return await internalSafePullWithStatus(this, nodeName, positionalBindings);
    }

    /**
     * @param {NodeKeyString} nodeKeyStr
     * @returns {Promise<RecomputeResult>}
     */
    async pullByNodeKeyStringWithStatus(nodeKeyStr) {
        return await internalPullByNodeKeyStringWithStatus(this, nodeKeyStr);
    }

    /**
     * @param {NodeKeyString} nodeKeyStr
     * @returns {Promise<RecomputeResult>}
     */
    async pullByNodeKeyStringWithStatusDuringPull(nodeKeyStr) {
        return await internalPullByNodeKeyStringWithStatusDuringPull(
            this,
            nodeKeyStr
        );
    }

    /**
     * @param {string} head
     * @param {Record<string, ConstValue>} [bindings={}]
     * @returns {Promise<"up-to-date" | "potentially-outdated" | "missing">}
     */
    async getFreshness(head, bindings = {}) {
        const nodeNameTyped = stringToNodeName(head);
        const compiledNode = this.headIndex.get(nodeNameTyped);
        if (!compiledNode) throw makeInvalidNodeError(nodeNameTyped);
        const positionalBindings = bindingsMapToPositional(compiledNode, bindings);
        return await internalGetFreshness(this, head, positionalBindings);
    }

    /**
     * @param {string} head
     * @param {Record<string, ConstValue>} [bindings={}]
     * @returns {Promise<ComputedValue | undefined>}
     */
    async getValue(head, bindings = {}) {
        const nodeNameTyped = stringToNodeName(head);
        const compiledNode = this.headIndex.get(nodeNameTyped);
        if (!compiledNode) throw makeInvalidNodeError(nodeNameTyped);
        const positionalBindings = bindingsMapToPositional(compiledNode, bindings);
        return await internalGetValue(this, head, positionalBindings);
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
     * @param {Record<string, ConstValue>} [bindings={}]
     * @returns {Promise<DateTime>}
     */
    async getCreationTime(nodeName, bindings = {}) {
        const nodeNameTyped = stringToNodeName(nodeName);
        const compiledNode = this.headIndex.get(nodeNameTyped);
        if (!compiledNode) throw makeInvalidNodeError(nodeNameTyped);
        const positionalBindings = bindingsMapToPositional(compiledNode, bindings);
        return await internalGetCreationTime(this, nodeName, positionalBindings);
    }

    /**
     * @param {string} nodeName
     * @param {Record<string, ConstValue>} [bindings={}]
     * @returns {Promise<DateTime>}
     */
    async getModificationTime(nodeName, bindings = {}) {
        const nodeNameTyped = stringToNodeName(nodeName);
        const compiledNode = this.headIndex.get(nodeNameTyped);
        if (!compiledNode) throw makeInvalidNodeError(nodeNameTyped);
        const positionalBindings = bindingsMapToPositional(compiledNode, bindings);
        return await internalGetModificationTime(this, nodeName, positionalBindings);
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
