/**
 * Compute meta_events from all_events and current meta_events.
 */

const { equal } = require("../../../event");

/** @typedef {import('../../../event').Event} Event */

/**
 * @typedef {Object} MetaEventAdd
 * @property {"add"} action - The action type
 * @property {Event} event - The event being added
 */

/**
 * @typedef {Object} MetaEventDelete
 * @property {"delete"} action - The action type
 * @property {Event} event - The event being deleted
 */

/**
 * @typedef {Object} MetaEventEdit
 * @property {"edit"} action - The action type
 * @property {Event} event - The new version of the event
 */

/**
 * @typedef {MetaEventAdd | MetaEventDelete | MetaEventEdit} MetaEvent
 */

/**
 * Reconstructs the event state from a list of meta events.
 * @param {Array<MetaEvent>} metaEvents - Array of meta events
 * @returns {Map<string, Event>} Map of event ID to event
 */
function reconstructFromMetaEvents(metaEvents) {
    const events = new Map();

    for (const metaEvent of metaEvents) {
        const eventId = metaEvent.event.id.identifier;

        if (metaEvent.action === "add") {
            events.set(eventId, metaEvent.event);
        } else if (metaEvent.action === "delete") {
            events.delete(eventId);
        } else if (metaEvent.action === "edit") {
            events.set(eventId, metaEvent.event);
        }
    }

    return events;
}

/**
 * Computes the new meta_events array that represents the transformation
 * from reconstructed state to all_events.
 *
 * @param {Array<Event>} allEvents - The target state (all events)
 * @param {Array<MetaEvent>} currentMetaEvents - The current meta events
 * @returns {Array<MetaEvent> | "unchanged"} The new meta events array
 */
function computeMetaEvents(allEvents, currentMetaEvents) {
    // Reconstruct the current state from meta events
    const reconstructed = reconstructFromMetaEvents(currentMetaEvents);

    // Create a map of all_events for easier lookup
    const allEventsMap = new Map();
    for (const event of allEvents) {
        allEventsMap.set(event.id.identifier, event);
    }

    // Start with a copy of the current meta events
    const newMetaEvents = [...currentMetaEvents];

    // Find events that need to be added or edited
    for (const event of allEvents) {
        const existingEvent = reconstructed.get(event.id.identifier);

        if (!existingEvent) {
            // Event doesn't exist in reconstructed state - add it
            newMetaEvents.push({
                action: "add",
                event: event,
            });
        } else if (!equal(existingEvent, event)) {
            // Event exists but has changed - edit it
            newMetaEvents.push({
                action: "edit",
                event: event,
            });
        }
        // If event exists and is equal, no action needed
    }

    // Find events that need to be deleted
    for (const [eventId, reconstructedEvent] of reconstructed) {
        if (!allEventsMap.has(eventId)) {
            // Event exists in reconstructed but not in all_events - delete it
            newMetaEvents.push({
                action: "delete",
                event: reconstructedEvent,
            });
        }
    }

    if (currentMetaEvents.length === newMetaEvents.length) {
        return "unchanged";
    }

    return newMetaEvents;
}

module.exports = {
    computeMetaEvents,
    reconstructFromMetaEvents,
};
