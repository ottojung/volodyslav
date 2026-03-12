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
 * @param {InterfaceQueryAccess} interfaceInstance
 * @returns {Promise<Array<Event>>}
 */
async function internalGetSortedEvents(interfaceInstance) {
    await interfaceInstance.ensureInitialized();
    const result = await interfaceInstance
        ._requireInitializedGraph()
        .pull("sorted_events");
    if (result.type !== "sorted_events") {
        throw new Error(`Expected sorted_events entry but got type: ${result.type}`);
    }
    return result.events.map(deserialize);
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
    internalGetCaloriesForEventId,
    internalGetConfig,
    internalGetEvent,
    internalGetEventBasicContext,
    internalGetEventTranscriptionForAudioPath,
};
