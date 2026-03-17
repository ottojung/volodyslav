/**
 * Interface class for direct database operations.
 */

/** @typedef {import('../../event').Event} Event */
/** @typedef {import('../incremental_graph/database/root_database').RootDatabase} RootDatabase */
/** @typedef {import('../incremental_graph').IncrementalGraph} IncrementalGraph */
/** @typedef {import('./types').GeneratorsCapabilities} GeneratorsCapabilities */
/** @typedef {import('../individual/all_events/wrapper').AllEventsBox} AllEventsBox */
/** @typedef {import('../individual/config/wrapper').ConfigBox} ConfigBox */

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
    internalInvalidateGraphNode,
    internalPullGraphNode,
    internalSetConfig,
    internalUpdate,
} = require("./graph_api");
const {
    internalGetAllEvents,
    internalGetSortedEvents,
    internalGetEventsCount,
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
     * Boxed event list captured by the all_events computor.
     * @type {AllEventsBox | null}
     */
    _allEventsBox;

    /**
     * Boxed config captured by the config computor.
     * @type {ConfigBox | null}
     */
    _configBox;

    /**
     * @constructor
     * @param {() => GeneratorsCapabilities} getCapabilities - Lazy getter for capabilities
     */
    constructor(getCapabilities) {
        this._getCapabilities = getCapabilities;
        this._incrementalGraph = null;
        this._database = null;
        this._allEventsBox = null;
        this._configBox = null;
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

    /**
     * @param {Array<Event>} newEntries
     * @returns {Promise<void>}
     */
    async update(newEntries) {
        await internalUpdate(this, newEntries);
    }

    /**
     * @param {import('../../config/structure').Config | null} config
     * @returns {Promise<void>}
     */
    async setConfig(config) {
        await internalSetConfig(this, config);
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
     * Returns the current configuration from the incremental graph.
     * Reads from the cached `config` graph node instead of performing a
     * full gitstore transaction, making reads significantly faster.
     * @returns {Promise<import('../../config/structure').Config | null>}
     */
    async getConfig() {
        return await internalGetConfig(this);
    }

    /**
     * Returns an async iterator over events in sorted date order.
     *
     * The first up to SORTED_EVENTS_CACHE_SIZE events are yielded from a small
     * dedicated cache node (`last_entries(n)` for descending, `first_entries(n)`
     * for ascending; both pulled with n = SORTED_EVENTS_CACHE_SIZE) which can
     * be read from LevelDB much faster than the full sorted list.  Only if more
     * events exist does the iterator fall through to the complete
     * `sorted_events_descending` / `sorted_events_ascending` node.
     *
     * Events are deserialized lazily — one at a time as the caller advances the
     * iterator — so callers that stop early (e.g. after collecting a single
     * page) never pay to deserialize entries they will not use.
     *
     * @param {'dateAscending'|'dateDescending'} order
     * @returns {AsyncGenerator<Event>}
     */
    async* getSortedEvents(order) {
        yield* internalGetSortedEvents(this, order);
    }

    /**
     * Returns the total number of events from the cached `events_count` graph
     * node.  This is O(1) and does not require iterating all events.
     * @returns {Promise<number>}
     */
    async getEventsCount() {
        return await internalGetEventsCount(this);
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
