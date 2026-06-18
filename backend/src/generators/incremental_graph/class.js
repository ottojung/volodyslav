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
const {
    makeGraphStorage,
} = require("./graph_state");
const { buildGraphSchemeFromNodeDefs, serializeGraphScheme, GRAPH_SCHEME_KEY } = require("./database");
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
} = require("./invalidate");
const { makeConcreteNodeCache } = require("./lru_cache");
const {
    internalPull,
} = require("./pull");

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

        this.graphScheme = buildGraphSchemeFromNodeDefs(compiledNodes);
        this.storage = makeGraphStorage(rootDatabase, capabilities.sleeper);
        this.rootDatabase = rootDatabase;
        this.dbVersion = rootDatabase.getVersion();
        this.headIndex = new Map();
        for (const compiledNode of compiledNodes) {
            this.headIndex.set(compiledNode.head, compiledNode);
        }

        void rootDatabase.getSchemaStorage().global.put(GRAPH_SCHEME_KEY, JSON.stringify(serializeGraphScheme(this.graphScheme)));

        this.concreteInstantiations = makeConcreteNodeCache();
        this.sleeper = capabilities.sleeper;
        this.datetime = capabilities.datetime;
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
     * @param {string} nodeName
     * @param {Array<ConstValue>} [bindings=[]]
     * @returns {Promise<ComputedValue>}
     */
    async pull(nodeName, bindings = []) {
        return await internalPull(this, nodeName, bindings);
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
