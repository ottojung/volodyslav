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
const {
    buildGraphSchemeFromNodeDefs,
    serializeGraphScheme,
    GRAPH_SCHEME_KEY,
    MissingGraphSchemeError,
    assertExactStoredGraphSchemeMatches,
} = require("./database");
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

    /** @type {Promise<void>} */
    _graphSchemeReady;

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

        // The constructor stores a promise instead of using await because
        // constructors cannot be async.  Every public method that touches
        // graph storage awaits _initializeGraphScheme() before proceeding,
        // so the init/validation is guaranteed to complete before any
        // observable storage operation.  Pure schema introspection methods
        // (getSchemas, getSchemaByHead, getDbVersion) skip the await because
        // they do not touch database state.
        //
        // global/graph_scheme is immutable initialization metadata.
        // It is written only where global/version is written (migration/init).
        // The constructor validates but never writes.
        this.graphSchemeString = JSON.stringify(serializeGraphScheme(this.graphScheme));
        this._graphSchemeReady = this._initializeGraphScheme();

        this.concreteInstantiations = makeConcreteNodeCache();
        this.sleeper = capabilities.sleeper;
        this.datetime = capabilities.datetime;
    }

    /**
     * Validate the stored graph_scheme against the current scheme.
     *
     * global/graph_scheme is written only where global/version is written,
     * i.e. by migration/init code.  The constructor does not write to global.
     *
     * For a genuinely fresh database (no stored version and no stored scheme),
     * the scheme will be written by the migration runner (runMigrationUnsafe)
     * alongside global/version before any graph storage operations.
     *
     * For an existing initialized database whose stored version matches the
     * current application version, validates that the stored scheme matches
     * the current scheme exactly.  No overwriting, no normalization,
     * no silent backfill.
     *
     * For an existing initialized database whose stored version differs from
     * the current application version (needs migration), the stored scheme
     * is allowed to differ — the migration callback will write the new scheme
     * as part of the migration process.
     *
     * If a versioned database has no stored graph_scheme, treats this as
     * corruption and throws MissingGraphSchemeError.
     *
     * @returns {Promise<void>}
     */
    async _initializeGraphScheme() {
        const schemaStorage = this.rootDatabase.getSchemaStorage();
        const storedScheme = await schemaStorage.global.get(GRAPH_SCHEME_KEY);
        if (storedScheme !== undefined) {
            // Stored scheme exists — validate exact match
            // after checking version.
            const storedVersion = await schemaStorage.global.get('version');
            if (storedVersion !== undefined && storedVersion !== this.dbVersion) {
                // Version differs — skip validation (migration owns the new scheme)
                return;
            }
            assertExactStoredGraphSchemeMatches(
                storedScheme,
                this.graphSchemeString,
                `active replica '${this.rootDatabase.currentReplicaName()}'`
            );
            return;
        }
        // No stored scheme.
        const storedVersion = await schemaStorage.global.get('version');
        if (storedVersion === undefined) {
            // Fresh database — no stored scheme, no stored version.
            // Migration/init code will write both.
            return;
        }
        // Versioned database with no graph_scheme — corruption.
        throw new MissingGraphSchemeError(
            `active replica '${this.rootDatabase.currentReplicaName()}'`
        );
    }

    /** @returns {Promise<void>} */
    async _ensureGraphSchemeReady() {
        await this._graphSchemeReady;
    }

    /**
     * @param {string} nodeName
     * @param {Array<ConstValue>} [bindings=[]]
     * @returns {Promise<void>}
     */
    async invalidate(nodeName, bindings = []) {
        await this._ensureGraphSchemeReady();
        await internalInvalidate(this, nodeName, bindings);
    }

    /**
     * @param {string} nodeName
     * @param {Array<ConstValue>} [bindings=[]]
     * @returns {Promise<ComputedValue>}
     */
    async pull(nodeName, bindings = []) {
        await this._ensureGraphSchemeReady();
        return await internalPull(this, nodeName, bindings);
    }

    /**
     * @param {string} head
     * @param {Array<ConstValue>} [bindings=[]]
     * @returns {Promise<"up-to-date" | "potentially-outdated" | "missing">}
     */
    async getFreshness(head, bindings = []) {
        await this._ensureGraphSchemeReady();
        return await internalGetFreshness(this, head, bindings);
    }

    /**
     * @param {string} head
     * @param {Array<ConstValue>} [bindings=[]]
     * @returns {Promise<ComputedValue | undefined>}
     */
    async getValue(head, bindings = []) {
        await this._ensureGraphSchemeReady();
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
        await this._ensureGraphSchemeReady();
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
        await this._ensureGraphSchemeReady();
        return await internalGetCreationTime(this, nodeName, bindings);
    }

    /**
     * @param {string} nodeName
     * @param {Array<ConstValue>} [bindings=[]]
     * @returns {Promise<DateTime>}
     */
    async getModificationTime(nodeName, bindings = []) {
        await this._ensureGraphSchemeReady();
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
