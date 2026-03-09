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
const { isDateTime, fromISOString } = require('../../datetime');
const { id: eventIdModule } = require('../../event');

/**
 * Reconstructs a proper Event object from a potentially JSON-deserialized event.
 *
 * Events stored in the incremental graph database are serialized as plain JSON.
 * When read back from the DB cache, custom class instances (DateTime, EventId) become
 * plain objects. This function restores them to their proper types.
 *
 * @param {Event} ev - The potentially plain-JSON event object
 * @returns {Event}
 */
function rehydrateEvent(ev) {
    // Rehydrate the date field if it is not already a proper DateTime instance.
    // When a DateTimeClass is stored in the DB, JSON.stringify serializes the internal
    // Luxon DateTime (via its toJSON()) as an ISO string under the _luxonDateTime key.
    let date = ev.date;
    if (!isDateTime(date)) {
        const rawDate = ev.date;
        if (!rawDate || typeof rawDate !== 'object' || typeof rawDate._luxonDateTime !== 'string') {
            throw new Error(`Cannot rehydrate event date: ${JSON.stringify(ev.date)}`);
        }
        date = fromISOString(rawDate._luxonDateTime);
    }

    // Always rehydrate the id field to ensure we have a proper EventId instance.
    // When an EventIdClass is stored in the DB, JSON.stringify serializes it as a
    // plain object with an identifier string property.
    const rawId = ev.id;
    if (!rawId || typeof rawId.identifier !== 'string') {
        throw new Error(`Cannot rehydrate event id: ${JSON.stringify(ev.id)}`);
    }
    const id = eventIdModule.fromString(rawId.identifier);

    return { ...ev, date, id };
}

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
async function internalGetAllEvents(interfaceInstance) {
    await interfaceInstance.ensureInitialized();
    const result = await interfaceInstance
        ._requireInitializedGraph()
        .pull("all_events");
    if (result.type !== "all_events") {
        throw new Error(`Expected all_events entry but got type: ${result.type}`);
    }
    return result.events.map(rehydrateEvent);
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
        return rehydrateEvent(result.value);
    } catch (error) {
        if (isEventNotFoundError(error)) {
            return null;
        }
        throw error;
    }
}

module.exports = {
    internalGetAllEvents,
    internalGetCaloriesForEventId,
    internalGetConfig,
    internalGetEvent,
    internalGetEventBasicContext,
    internalGetEventTranscriptionForAudioPath,
};
