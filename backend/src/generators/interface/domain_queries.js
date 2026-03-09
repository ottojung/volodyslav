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

module.exports = {
    internalGetCaloriesForEventId,
    internalGetEventBasicContext,
    internalGetEventTranscriptionForAudioPath,
};
