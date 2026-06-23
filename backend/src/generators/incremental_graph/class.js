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
 *
 * Lifecycle:
 *   IncrementalGraphClass construction is a pure object construction step with
 *   respect to storage lifecycle. The constructor receives already-prepared graph
 *   schema state, builds the runtime storage facade, and attaches capabilities.
 *   It does NOT compile node definitions, validate persistent metadata, or perform
 *   async storage reads/writes. prepareIncrementalGraphStorage() owns schema
 *   compilation, pure validation, durable metadata initialization, and durable
 *   metadata validation before graph construction.
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
/** @typedef {import('./types').NodeName} NodeName */
/** @typedef {import('./graph_state').GraphStorage} GraphStorage */
/** @typedef {import('./graph_state').BatchBuilder} BatchBuilder */
/** @typedef {import('./graph_state').Transaction} Transaction */
/** @typedef {import('./lru_cache').ConcreteNodeCache} ConcreteNodeCache */
/** @typedef {import('../../datetime').DateTime} DateTime */
/** @typedef {import('../../datetime').Datetime} Datetime */
/** @typedef {import('../../sleeper').SleepCapability} SleepCapability */
/** @typedef {import('./types').IncrementalGraphCapabilities} IncrementalGraphCapabilities */
/** @typedef {import('./database/graph_scheme').GraphScheme} GraphScheme */
/** @typedef {import('./prepare_graph_storage').PreparedGraphStorage} PreparedGraphStorage */

const {
    makeGraphStorage,
} = require("./graph_state");
const {
    prepareIncrementalGraphStorage,
} = require("./prepare_graph_storage");
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
    /** @type {Map<NodeName, CompiledNode>} */
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

    /** @type {GraphScheme} */
    graphScheme;

    /** @type {string} */
    graphSchemeString;

    /**
     * @param {IncrementalGraphCapabilities} capabilities
     * @param {RootDatabase} rootDatabase
     * @param {PreparedGraphStorage} prepared
     */
    constructor(capabilities, rootDatabase, prepared) {
        this.graphScheme = prepared.graphScheme;
        this.graphSchemeString = prepared.graphSchemeString;
        this.headIndex = prepared.headIndex;
        this.storage = makeGraphStorage(rootDatabase, capabilities.sleeper);
        this.rootDatabase = rootDatabase;
        this.dbVersion = rootDatabase.getVersion();
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
 * Construct an incremental graph from already-prepared storage state.
 * The caller must have called `prepareIncrementalGraphStorage` first.
 * @param {IncrementalGraphCapabilities} capabilities
 * @param {RootDatabase} rootDatabase
 * @param {PreparedGraphStorage} prepared
 * @returns {IncrementalGraphClass}
 */
function makeIncrementalGraph(capabilities, rootDatabase, prepared) {
    return new IncrementalGraphClass(capabilities, rootDatabase, prepared);
}

/**
 * Async convenience factory: prepares storage and constructs the graph.
 * This is the typical entry point for callers that do not need explicit
 * lifecycle control between preparation and construction.
 * @param {IncrementalGraphCapabilities} capabilities
 * @param {RootDatabase} rootDatabase
 * @param {import('./types').NodeDef[]} nodeDefs
 * @returns {Promise<IncrementalGraphClass>}
 */
async function createIncrementalGraph(capabilities, rootDatabase, nodeDefs) {
    const prepared = await prepareIncrementalGraphStorage(rootDatabase, nodeDefs);
    return new IncrementalGraphClass(capabilities, rootDatabase, prepared);
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
    createIncrementalGraph,
    isIncrementalGraph,
};
