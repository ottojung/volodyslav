/**
 * Domain-specific query helpers for the generators interface.
 */

/** @typedef {import('../../event').Event} Event */
/** @typedef {import('../incremental_graph/database/types').CaloriesEntry} CaloriesEntry */
/** @typedef {import('../incremental_graph/database/types').EventTranscriptionEntry} EventTranscriptionEntry */
/**
 * @typedef {object} InterfaceQueryAccess
 * @property {() => Promise<void>} ensureInitialized
 * @property {() => import('../incremental_graph').IncrementalGraph} _requireInitializedGraph
 */

const { isEventNotFoundError } = require('../individual').event;
const { deserialize } = require('../../event');
const { SORTED_EVENTS_CACHE_SIZE } = require('./constants');

/**
 * @param {InterfaceQueryAccess} interfaceInstance
 * @param {string} eventId
 * @returns {Promise<CaloriesEntry>}
 */
async function internalGetCaloriesForEventId(interfaceInstance, eventId) {
    const result = await interfaceInstance
        ._requireInitializedGraph()
        .pull("calories", [eventId]);
    if (result.type !== "calories") {
        throw new Error(`Expected calories entry but got type: ${result.type}`);
    }
    return result;
}

/**
 * @param {InterfaceQueryAccess} interfaceInstance
 * @param {string} eventId
 * @param {string} audioPath
 * @returns {Promise<EventTranscriptionEntry>}
 */
async function internalGetEventTranscriptionForAudioPath(
    interfaceInstance,
    eventId,
    audioPath
) {
    const result = await interfaceInstance
        ._requireInitializedGraph()
        .pull("event_transcription", [eventId, audioPath]);
    if (result.type !== "event_transcription") {
        throw new Error(
            `Expected event_transcription entry but got type: ${result.type}`
        );
    }
    return result;
}

/**
 * @param {InterfaceQueryAccess} interfaceInstance
 * @param {Event} event
 * @returns {Promise<Array<Event>>}
 */
async function internalGetEventBasicContext(interfaceInstance, event) {
    await interfaceInstance.ensureInitialized();
    const eventContextEntry = await interfaceInstance
        ._requireInitializedGraph()
        .pull("event_context");

    if (!eventContextEntry || eventContextEntry.type !== "event_context") {
        return [event];
    }

    const eventIdStr = event.id.identifier;
    const contextEntry = eventContextEntry.contexts.find(
        (context) => context.eventId === eventIdStr
    );

    if (!contextEntry) {
        return [event];
    }

    return contextEntry.context;
}

/**
 * @param {InterfaceQueryAccess} interfaceInstance
 * @returns {Promise<import('../../config/structure').Config | null>}
 */
async function internalGetConfig(interfaceInstance) {
    await interfaceInstance.ensureInitialized();
    const result = await interfaceInstance
        ._requireInitializedGraph()
        .pull("config");
    if (result.type !== "config") {
        throw new Error(`Expected config entry but got type: ${result.type}`);
    }
    return result.config;
}

/**
 * Returns an async iterator over events in sorted date order.
 *
 * ## Two-phase iteration for speed
 *
 * For the common case (first page, small result set) the iterator avoids
 * reading the potentially-large full sorted list from LevelDB by first
 * yielding from one of two dedicated small-cache nodes:
 *
 *   - `last_entries(n)` – most-recent SORTED_EVENTS_CACHE_SIZE events
 *                         (used for `'dateDescending'` order; pulled with
 *                         n = SORTED_EVENTS_CACHE_SIZE)
 *   - `first_entries(n)` – oldest SORTED_EVENTS_CACHE_SIZE events
 *                         (used for `'dateAscending'` order; pulled with
 *                         n = SORTED_EVENTS_CACHE_SIZE)
 *
 * If and only if more than SORTED_EVENTS_CACHE_SIZE events exist (i.e. the
 * cache was filled to capacity) does the iterator fall through to the full
 * sorted list (`sorted_events_descending` / `sorted_events_ascending`),
 * skipping the first SORTED_EVENTS_CACHE_SIZE entries that were already
 * yielded from the cache.
 *
 * ## Lazy deserialization
 *
 * Each event is deserialized from its stored `SerializedEvent` form only when
 * the caller advances the iterator (i.e. pulls the next value).  This avoids
 * allocating full Event objects for entries the caller never consumes.
 *
 * @param {InterfaceQueryAccess} interfaceInstance
 * @param {'dateAscending'|'dateDescending'} order
 * @returns {AsyncGenerator<Event>}
 */
async function* internalGetSortedEvents(interfaceInstance, order) {
    if (order !== "dateAscending" && order !== "dateDescending") {
        throw new Error(
            `internalGetSortedEvents: unsupported order value: ${JSON.stringify(order)}. ` +
            `Expected 'dateAscending' or 'dateDescending'.`
        );
    }
    await interfaceInstance.ensureInitialized();
    const graph = interfaceInstance._requireInitializedGraph();

    // ── Phase 1: yield from the small cache node ─────────────────────────────
    // Pulling a small entry (≤ SORTED_EVENTS_CACHE_SIZE events) from LevelDB
    // is much faster than pulling the full sorted list.
    const cacheNodeHead =
        order === "dateAscending" ? "first_entries" : "last_entries";

    const cacheEntry = await graph.pull(cacheNodeHead, [SORTED_EVENTS_CACHE_SIZE]);
    if (cacheEntry.type !== cacheNodeHead) {
        throw new Error(
            `Expected ${cacheNodeHead} entry but got type: ${cacheEntry.type}`
        );
    }

    const cachedEvents = cacheEntry.events;
    for (const serialized of cachedEvents) {
        yield deserialize(serialized);
    }

    // If the cache held fewer than SORTED_EVENTS_CACHE_SIZE events then all
    // events have been yielded — there is no full list to fall through to.
    if (cachedEvents.length < SORTED_EVENTS_CACHE_SIZE) {
        return;
    }

    // The cache is exactly full.  Before paying for a full sorted-list read,
    // check the cheap `events_count` node.  If the total number of events is
    // at most SORTED_EVENTS_CACHE_SIZE, the cache already holds everything and
    // we can return early (handles the "exactly 100 events" boundary case).
    const countEntry = await graph.pull("events_count");
    if (countEntry.type !== "events_count") {
        throw new Error(
            `Expected events_count entry but got type: ${countEntry.type}`
        );
    }
    if (countEntry.count <= SORTED_EVENTS_CACHE_SIZE) {
        return;
    }

    // ── Phase 2: continue from the full sorted list ───────────────────────────
    // We already yielded the first SORTED_EVENTS_CACHE_SIZE events from the
    // cache, so iterate the remaining events by index via Array.entries().
    // Using entries() means each element is typed as SerializedEvent (not
    // SerializedEvent | undefined), avoiding both a slice() copy and an
    // index-access type widening.
    const fullNodeName =
        order === "dateAscending"
            ? "sorted_events_ascending"
            : "sorted_events_descending";

    const fullEntry = await graph.pull(fullNodeName);
    if (fullEntry.type !== fullNodeName) {
        throw new Error(
            `Expected ${fullNodeName} entry but got type: ${fullEntry.type}`
        );
    }

    for (const [i, serialized] of fullEntry.events.entries()) {
        if (i >= SORTED_EVENTS_CACHE_SIZE) {
            yield deserialize(serialized);
        }
    }
}

/**
 * Returns the total number of events from the cached `events_count` graph
 * node.  This is O(1) and does not require iterating all events.
 *
 * @param {InterfaceQueryAccess} interfaceInstance
 * @returns {Promise<number>}
 */
async function internalGetEventsCount(interfaceInstance) {
    await interfaceInstance.ensureInitialized();
    const result = await interfaceInstance
        ._requireInitializedGraph()
        .pull("events_count");
    if (result.type !== "events_count") {
        throw new Error(`Expected events_count entry but got type: ${result.type}`);
    }
    return result.count;
}

/**
 * @param {InterfaceQueryAccess} interfaceInstance
 * @returns {Promise<Array<Event>>}
 */
async function internalGetAllEvents(interfaceInstance) {
    await interfaceInstance.ensureInitialized();
    const result = await interfaceInstance
        ._requireInitializedGraph()
        .pull("all_events");
    if (result.type !== "all_events") {
        throw new Error(`Expected all_events entry but got type: ${result.type}`);
    }
    return result.events.map(deserialize);
}

/**
 * @param {InterfaceQueryAccess} interfaceInstance
 * @param {string} eventId
 * @returns {Promise<Event | null>}
 */
async function internalGetEvent(interfaceInstance, eventId) {
    await interfaceInstance.ensureInitialized();
    try {
        const result = await interfaceInstance
            ._requireInitializedGraph()
            .pull("event", [eventId]);
        if (result.type !== "event") {
            throw new Error(`Expected event entry but got type: ${result.type}`);
        }
        return deserialize(result.value);
    } catch (error) {
        if (isEventNotFoundError(error)) {
            return null;
        }
        throw error;
    }
}

module.exports = {
    internalGetAllEvents,
    internalGetSortedEvents,
    internalGetEventsCount,
    internalGetCaloriesForEventId,
    internalGetConfig,
    internalGetEvent,
    internalGetEventBasicContext,
    internalGetEventTranscriptionForAudioPath,
};
