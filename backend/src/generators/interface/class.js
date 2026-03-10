/**
 * Interface class for direct database operations.
 */

/** @typedef {import('../../event').Event} Event */
/** @typedef {import('../incremental_graph/database/root_database').RootDatabase} RootDatabase */
/** @typedef {import('../incremental_graph').IncrementalGraph} IncrementalGraph */
/** @typedef {import('./types').GeneratorsCapabilities} GeneratorsCapabilities */

const {
    internalEnsureInitialized,
    internalIsInitialized,
    internalRequireInitializedGraph,
    internalSynchronizeDatabase,
} = require("./lifecycle");
const {
    internalDebugGetFreshness,
    internalDebugGetSchemaByHead,
    internalDebugGetSchemas,
    internalDebugGetValue,
    internalDebugListMaterializedNodes,
    internalGetCreationTime,
    internalGetModificationTime,
    internalGetCreator,
    internalInvalidateGraphNode,
    internalPullGraphNode,
    internalUpdate,
} = require("./graph_api");
const {
    internalGetAllEvents,
    internalGetCaloriesForEventId,
    internalGetConfig,
    internalGetEvent,
    internalGetEventBasicContext,
    internalGetEventTranscriptionForAudioPath,
} = require("./domain_queries");

/** Interface that encapsulates incremental-graph operations. */
class InterfaceClass {
    /**
     * Lazy getter for the capabilities object, captured at construction time.
     * @type {() => GeneratorsCapabilities}
     */
    _getCapabilities;

    /**
     * The live incremental graph, available after ensureInitialized().
     * @type {IncrementalGraph | null}
     */
    _incrementalGraph;

    /**
     * The currently open root database, available after ensureInitialized().
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
        return internalIsInitialized(this);
    }

    /** @returns {IncrementalGraph} */
    _requireInitializedGraph() {
        return internalRequireInitializedGraph(this);
    }

    /** @returns {Promise<void>} */
    async ensureInitialized() {
        await internalEnsureInitialized(this);
    }

    /** @param {{ resetToTheirs?: boolean }} [options] */
    async synchronizeDatabase(options) {
        await internalSynchronizeDatabase(this, options);
    }

    /** @returns {Promise<void>} */
    async update() {
        await internalUpdate(this);
    }

    /**
     * @returns {Array<import('../incremental_graph/types').CompiledNode>}
     */
    debugGetSchemas() {
        return internalDebugGetSchemas(this);
    }

    /**
     * @param {string} head
     * @returns {import('../incremental_graph/types').CompiledNode | null}
     */
    debugGetSchemaByHead(head) {
        return internalDebugGetSchemaByHead(this, head);
    }

    /**
     * @returns {Promise<Array<[string, Array<import('../incremental_graph/types').ConstValue>]>>}
     */
    async debugListMaterializedNodes() {
        return await internalDebugListMaterializedNodes(this);
    }

    /**
     * @param {string} head
     * @param {Array<import('../incremental_graph/types').ConstValue>} [args]
     * @returns {Promise<import('../incremental_graph/types').FreshnessStatus>}
     */
    async debugGetFreshness(head, args = []) {
        return await internalDebugGetFreshness(this, head, args);
    }

    /**
     * @param {string} head
     * @param {Array<import('../incremental_graph/types').ConstValue>} [args]
     * @returns {Promise<import('../incremental_graph/types').ComputedValue | undefined>}
     */
    async debugGetValue(head, args = []) {
        return await internalDebugGetValue(this, head, args);
    }

    /**
     * Pulls one concrete graph node for the graph API.
     * @param {string} head
     * @param {Array<import('../incremental_graph/types').ConstValue>} [args]
     * @returns {Promise<import('../incremental_graph/types').ComputedValue>}
     */
    async pullGraphNode(head, args = []) {
        return await internalPullGraphNode(this, head, args);
    }

    /**
     * Invalidates one concrete graph node for the graph API.
     * @param {string} head
     * @param {Array<import('../incremental_graph/types').ConstValue>} [args]
     * @returns {Promise<void>}
     */
    async invalidateGraphNode(head, args = []) {
        return await internalInvalidateGraphNode(this, head, args);
    }

    /**
     * @param {string} head
     * @param {Array<import('../incremental_graph/types').ConstValue>} [args]
     * @returns {Promise<import('../../datetime').DateTime>}
     */
    async getCreationTime(head, args = []) {
        return await internalGetCreationTime(this, head, args);
    }

    /**
     * @param {string} head
     * @param {Array<import('../incremental_graph/types').ConstValue>} [args]
     * @returns {Promise<import('../../datetime').DateTime>}
     */
    async getModificationTime(head, args = []) {
        return await internalGetModificationTime(this, head, args);
    }

    /**
     * @param {string} head
     * @param {Array<import('../incremental_graph/types').ConstValue>} [args]
     * @returns {Promise<string>}
     */
    async getCreator(head, args = []) {
        return await internalGetCreator(this, head, args);
    }

    /**
     * Returns the current configuration from the incremental graph.
     * Reads from the cached `config` graph node instead of performing a
     * full gitstore transaction, making reads significantly faster.
     * @returns {Promise<import('../../config/structure').Config | null>}
     */
    async getConfig() {
        return await internalGetConfig(this);
    }

    /**
     * Returns all events from the incremental graph.
     * Reads from the cached `all_events` graph node instead of performing a
     * full gitstore transaction, making reads significantly faster.
     * @returns {Promise<Array<Event>>}
     */
    async getAllEvents() {
        return await internalGetAllEvents(this);
    }

    /**
     * Returns a single event by its ID from the incremental graph, or null if
     * no event with that ID exists.
     * @param {string} eventId
     * @returns {Promise<Event | null>}
     */
    async getEvent(eventId) {
        return await internalGetEvent(this, eventId);
    }

    /**
     * @param {string} eventId
     * @returns {Promise<import('../incremental_graph/database/types').CaloriesEntry>}
     */
    async getCaloriesForEventId(eventId) {
        return await internalGetCaloriesForEventId(this, eventId);
    }

    /**
     * @param {string} eventId
     * @param {string} audioPath - Audio path relative to the assets root
     * @returns {Promise<import('../incremental_graph/database/types').EventTranscriptionEntry>}
     */
    async getEventTranscriptionForAudioPath(eventId, audioPath) {
        return await internalGetEventTranscriptionForAudioPath(
            this,
            eventId,
            audioPath
        );
    }

    /**
     * @param {Event} event
     * @returns {Promise<Array<Event>>}
     */
    async getEventBasicContext(event) {
        return await internalGetEventBasicContext(this, event);
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
