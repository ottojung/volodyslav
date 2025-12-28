/**
 * Compute event_context from meta_events.
 */

/** @typedef {import('../../../event').Event} Event */
/** @typedef {import('../meta_events').MetaEvent} MetaEvent */
/** @typedef {import('../../event_context').getEventBasicContext} getEventBasicContext */

const eventContextModule = require('../../event_context');

/**
 * Reconstructs all_events from meta_events.
 * @param {Array<MetaEvent>} metaEvents - Array of meta events
 * @returns {Array<Event>} Array of reconstructed events
 */
function reconstructEventsFromMetaEvents(metaEvents) {
    const eventsMap = new Map();

    for (const metaEvent of metaEvents) {
        const eventId = metaEvent.event.id.identifier;

        if (metaEvent.action === "add") {
            eventsMap.set(eventId, metaEvent.event);
        } else if (metaEvent.action === "delete") {
            eventsMap.delete(eventId);
        } else if (metaEvent.action === "edit") {
            eventsMap.set(eventId, metaEvent.event);
        }
    }

    return Array.from(eventsMap.values());
}

/**
 * @typedef {Object} EventContextEntry
 * @property {string} eventId - The event ID
 * @property {Array<Event>} context - The context events for this event
 */

/**
 * Computes event contexts for all events based on meta_events.
 *
 * @param {Array<MetaEvent>} metaEvents - The meta events
 * @returns {Array<EventContextEntry>} Array of event contexts
 */
function computeEventContexts(metaEvents) {
    // Reconstruct all_events from meta_events
    const allEvents = reconstructEventsFromMetaEvents(metaEvents);

    // Compute context for each event
    const eventContexts = [];
    for (const event of allEvents) {
        const context = eventContextModule.getEventBasicContext(allEvents, event);
        eventContexts.push({
            eventId: event.id.identifier,
            context: context,
        });
    }

    return eventContexts;
}

module.exports = {
    computeEventContexts,
    reconstructEventsFromMetaEvents,
};
