/**
 * Interface class for direct database operations.
 */

/** @typedef {import('../../event').Event} Event */
/** @typedef {import('../incremental_graph').IncrementalGraph} IncrementalGraph */
/** @typedef {import('../incremental_graph/database/root_database').RootDatabase} RootDatabase */
/** @typedef {import('../incremental_graph/types').NodeDef} NodeDef */
/** @typedef {import('../incremental_graph/migration_storage').MigrationStorage} MigrationStorage */
/** @typedef {import('./types').GeneratorsCapabilities} GeneratorsCapabilities */

const {
    makeIncrementalGraph,
    getRootDatabase,
    runMigration,
    runMigrationUnsafe,
    synchronizeNoLock,
    withMutex,
} = require("../incremental_graph");
const { createDefaultGraphDefinition } = require("./default_graph");
const { migrationCallback } = require("../incremental_graph");
const { makeSynchronizeDatabaseError } = require("./errors");

/** Interface for direct incremental-graph operations. */
class InterfaceClass {
    /**
     * Lazy getter for the capabilities object, captured at construction time.
     * @private
     * @type {() => GeneratorsCapabilities}
     */
    _getCapabilities;

    /**
     * The live incremental graph, available after ensureInitialized().
     * @private
     * @type {IncrementalGraph | null}
     */
    _incrementalGraph;

    /**
     * The currently open root database, available after ensureInitialized().
     * @private
     * @type {RootDatabase | null}
     */
    _database;

    /**
     * @constructor
     * @param {() => GeneratorsCapabilities} getCapabilities - Lazy getter for capabilities
     */
    constructor(getCapabilities) {
        this._getCapabilities = getCapabilities;
        this._incrementalGraph = null;
        this._database = null;
    }

    /**
     * @returns {boolean}
     */
    isInitialized() {
        return this._incrementalGraph !== null;
    }

    /**
     * @private
     * @returns {IncrementalGraph}
     */
    _requireInitializedGraph() {
        if (this._incrementalGraph === null) {
            throw new Error("Impossible: expected non-null");
        }
        return this._incrementalGraph;
    }

    /** @returns {Promise<void>} */
    async ensureInitialized() {
        await this._ensureInitialized(runMigration);
    }

    /**
     * @private
     * @param {(capabilities: GeneratorsCapabilities, database: RootDatabase, nodeDefs: Array<NodeDef>, callback: (storage: MigrationStorage) => Promise<void>) => Promise<void>} runMigrationProcedure
     * @returns {Promise<void>}
     */
    async _ensureInitialized(runMigrationProcedure) {
        if (this._incrementalGraph !== null) {
            return;
        }

        const capabilities = this._getCapabilities();
        const database = await getRootDatabase(capabilities);
        const nodeDefs = createDefaultGraphDefinition(capabilities);
        await runMigrationProcedure(
            capabilities,
            database,
            nodeDefs,
            migrationCallback(capabilities),
        );
        this._database = database;
        this._incrementalGraph = makeIncrementalGraph(capabilities, database, nodeDefs);
    }

    /** @param {{ resetToTheirs?: boolean }} [options] */
    async synchronizeDatabase(options) {
        await withMutex(this._getCapabilities().sleeper, async () => {
            await this._synchronizeDatabaseNoLock(options);
        });
    }

    /**
     * @private
     * @param {{ resetToTheirs?: boolean }} [options]
     * @returns {Promise<void>}
     */
    async _synchronizeDatabaseNoLock(options) {
        const capabilities = this._getCapabilities();
        const database = this._database;
        const incrementalGraph = this._incrementalGraph;
        if (database === null) {
            await synchronizeNoLock(capabilities, options);
            return;
        }

        this._database = null;
        this._incrementalGraph = null;

        try {
            await database.close();
        } catch (error) {
            this._database = database;
            this._incrementalGraph = incrementalGraph;
            throw error;
        }

        let synchronizeFailure = null;

        try {
            await synchronizeNoLock(capabilities, options);
        } catch (error) {
            synchronizeFailure = error;
        }

        let reopenFailure = null;
        try {
            await this._ensureInitialized(runMigrationUnsafe);
        } catch (error) {
            reopenFailure = error;
        }

        if (reopenFailure !== null) {
            if (synchronizeFailure !== null) {
                throw makeSynchronizeDatabaseError(synchronizeFailure, reopenFailure);
            }
            throw reopenFailure;
        }
        if (synchronizeFailure !== null) {
            throw synchronizeFailure;
        }
    }

    /** @returns {Promise<void>} */
    async update() {
        await this.ensureInitialized();
        await this._requireInitializedGraph().invalidate("all_events");
    }

    /**
     * @param {string} head
     * @param {Array<import('../incremental_graph/types').ConstValue>} [args]
     * @returns {Promise<unknown>}
     */
    async pull(head, args = []) {
        return await this._requireInitializedGraph().pull(head, args);
    }

    /**
     * @returns {Array<import('../incremental_graph/types').CompiledNode>}
     */
    debugGetSchemas() {
        return this._requireInitializedGraph().debugGetSchemas();
    }

    /**
     * @param {string} head
     * @returns {import('../incremental_graph/types').CompiledNode | null}
     */
    debugGetSchemaByHead(head) {
        return this._requireInitializedGraph().debugGetSchemaByHead(head);
    }

    /**
     * @returns {Promise<Array<[string, Array<import('../incremental_graph/types').ConstValue>]>>}
     */
    async debugListMaterializedNodes() {
        return await this._requireInitializedGraph().debugListMaterializedNodes();
    }

    /**
     * @param {string} head
     * @param {Array<import('../incremental_graph/types').ConstValue>} [args]
     * @returns {Promise<import('../incremental_graph/types').Freshness>}
     */
    async debugGetFreshness(head, args = []) {
        return await this._requireInitializedGraph().debugGetFreshness(head, args);
    }

    /**
     * @param {string} head
     * @param {Array<import('../incremental_graph/types').ConstValue>} [args]
     * @returns {Promise<unknown>}
     */
    async debugGetValue(head, args = []) {
        return await this._requireInitializedGraph().debugGetValue(head, args);
    }

    /**
     * @param {string} head
     * @param {Array<import('../incremental_graph/types').ConstValue>} [args]
     * @returns {Promise<import('../../datetime').DateTime>}
     */
    async getCreationTime(head, args = []) {
        return await this._requireInitializedGraph().getCreationTime(head, args);
    }

    /**
     * @param {string} head
     * @param {Array<import('../incremental_graph/types').ConstValue>} [args]
     * @returns {Promise<import('../../datetime').DateTime>}
     */
    async getModificationTime(head, args = []) {
        return await this._requireInitializedGraph().getModificationTime(head, args);
    }

    /**
     * @param {Event} event
     * @returns {Promise<Array<Event>>}
     */
    async getEventBasicContext(event) {
        await this.ensureInitialized();
        const eventContextEntry = await this._requireInitializedGraph().pull(
            "event_context"
        );

        if (!eventContextEntry || eventContextEntry.type !== "event_context") {
            return [event];
        }

        const eventIdStr = event.id.identifier;
        const contextEntry = eventContextEntry.contexts.find(
            (ctx) => ctx.eventId === eventIdStr
        );

        if (!contextEntry) {
            return [event];
        }

        return contextEntry.context;
    }
}

/** @param {() => GeneratorsCapabilities} getCapabilities */
function makeInterface(getCapabilities) {
    return new InterfaceClass(getCapabilities);
}

/**
 * @param {unknown} object
 * @returns {object is InterfaceClass}
 */
function isInterface(object) {
    return object instanceof InterfaceClass;
}

/** @typedef {InterfaceClass} Interface */

module.exports = {
    makeInterface,
    isInterface,
};
