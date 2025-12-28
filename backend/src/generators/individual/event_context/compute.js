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
 * @typedef {Object} IncrementalState
 * @property {number} lastProcessedLength - The last processed length of meta_events
 * @property {Object<string, Event>} eventsMap - Map of event ID to event (stored as object)
 * @property {Object<string, Array<Event>>} contextsMap - Map of event ID to its context (stored as object)
 */

/**
 * Computes event contexts incrementally from new meta_events entries.
 *
 * @param {Array<MetaEvent>} metaEvents - The full meta events array
 * @param {IncrementalState | null} previousState - Previous computation state, or null for full computation
 * @returns {{contexts: Array<EventContextEntry>, state: IncrementalState}} Result with contexts and new state
 */
function computeEventContextsIncremental(metaEvents, previousState) {
    // Initialize state
    const lastProcessedLength = previousState ? previousState.lastProcessedLength : 0;
    
    // Reconstruct Maps from stored arrays (database stores Maps as arrays of entries)
    const eventsMap = previousState && previousState.eventsMap
        ? new Map(Object.entries(previousState.eventsMap))
        : new Map();
    const contextsMap = previousState && previousState.contextsMap
        ? new Map(Object.entries(previousState.contextsMap))
        : new Map();

    // Process only new entries
    const newEntries = metaEvents.slice(lastProcessedLength);
    
    if (newEntries.length === 0) {
        // No new entries, return existing contexts
        const contexts = Array.from(contextsMap.entries()).map(([eventId, context]) => ({
            eventId,
            context,
        }));
        
        // Convert Maps to objects for database storage
        const eventsMapObject = Object.fromEntries(eventsMap);
        const contextsMapObject = Object.fromEntries(contextsMap);
        
        return {
            contexts,
            state: {
                lastProcessedLength,
                eventsMap: eventsMapObject,
                contextsMap: contextsMapObject,
            },
        };
    }

    // Track which events need context recomputation
    const affectedEventIds = new Set();

    // Process new meta events
    for (const metaEvent of newEntries) {
        const eventId = metaEvent.event.id.identifier;

        if (metaEvent.action === "add") {
            eventsMap.set(eventId, metaEvent.event);
            affectedEventIds.add(eventId);
            // Need to recompute contexts for events with shared hashtags
            for (const [existingId, existingEvent] of eventsMap) {
                if (existingId !== eventId && eventsShareContext(existingEvent, metaEvent.event)) {
                    affectedEventIds.add(existingId);
                }
            }
        } else if (metaEvent.action === "delete") {
            const deletedEvent = eventsMap.get(eventId);
            eventsMap.delete(eventId);
            contextsMap.delete(eventId);
            // Need to recompute contexts for events that shared context with deleted event
            if (deletedEvent) {
                for (const [existingId, existingEvent] of eventsMap) {
                    if (eventsShareContext(existingEvent, deletedEvent)) {
                        affectedEventIds.add(existingId);
                    }
                }
            }
        } else if (metaEvent.action === "edit") {
            const oldEvent = eventsMap.get(eventId);
            eventsMap.set(eventId, metaEvent.event);
            affectedEventIds.add(eventId);
            // Need to recompute for both old and new shared contexts
            if (oldEvent) {
                for (const [existingId, existingEvent] of eventsMap) {
                    if (existingId !== eventId && 
                        (eventsShareContext(existingEvent, oldEvent) || 
                         eventsShareContext(existingEvent, metaEvent.event))) {
                        affectedEventIds.add(existingId);
                    }
                }
            }
        }
    }

    // Recompute contexts for affected events
    const allEventsArray = Array.from(eventsMap.values());
    for (const eventId of affectedEventIds) {
        const event = eventsMap.get(eventId);
        if (event) {
            const context = eventContextModule.getEventBasicContext(allEventsArray, event);
            contextsMap.set(eventId, context);
        }
    }

    // Convert to array format
    const contexts = Array.from(contextsMap.entries()).map(([eventId, context]) => ({
        eventId,
        context,
    }));

    // Convert Maps to objects for database storage
    const eventsMapObject = Object.fromEntries(eventsMap);
    const contextsMapObject = Object.fromEntries(contextsMap);

    return {
        contexts,
        state: {
            lastProcessedLength: metaEvents.length,
            eventsMap: eventsMapObject,
            contextsMap: contextsMapObject,
        },
    };
}

/**
 * Helper function to check if two events share context (have common hashtags).
 * @param {Event} event1
 * @param {Event} event2
 * @returns {boolean}
 */
function eventsShareContext(event1, event2) {
    const { extractHashtags, isContextEnhancing } = require('../../../event');

    // Only context-enhancing events can share context
    if (!isContextEnhancing(event1.type) && !isContextEnhancing(event2.type)) {
        return false;
    }

    const hashtags1 = extractHashtags(event1);
    const hashtags2 = extractHashtags(event2);

    for (const tag of hashtags1) {
        if (hashtags2.has(tag)) {
            return true;
        }
    }
    return false;
}

/**
 * Computes event contexts for all events based on meta_events.
 * This is the non-incremental version for backward compatibility.
 *
 * @param {Array<MetaEvent>} metaEvents - The meta events
 * @returns {Array<EventContextEntry>} Array of event contexts
 */
function computeEventContexts(metaEvents) {
    const result = computeEventContextsIncremental(metaEvents, null);
    return result.contexts;
}

module.exports = {
    computeEventContexts,
    computeEventContextsIncremental,
    reconstructEventsFromMetaEvents,
};
