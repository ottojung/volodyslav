/**
 * Compute the basic context for an event ID from all_events.
 */

const { deserialize } = require("../../../event");
const { getEventBasicContext } = require("../../event_context");
const { makeUnchanged } = require("../../incremental_graph");
const { computeEventForId } = require("../event");

/** @typedef {import('../../../event').SerializedEvent} SerializedEvent */
/** @typedef {import('../../incremental_graph/database/types').BasicContextEntry} BasicContextEntry */
/** @typedef {import('../../incremental_graph/unchanged').Unchanged} Unchanged */

/**
 * @param {string} eventId
 * @param {BasicContextEntry | undefined} oldValue
 * @param {Array<SerializedEvent>} serializedEvents
 * @returns {BasicContextEntry | Unchanged}
 */
function computeBasicContextForEventId(eventId, oldValue, serializedEvents) {
    const eventEntry = computeEventForId(eventId, undefined, serializedEvents);
    const allEvents = serializedEvents.map(deserialize);
    const event = allEvents.find(
        (candidate) => candidate.id.identifier === eventEntry.value.id
    );
    if (event === undefined) {
        throw new Error(`Event with ID ${eventEntry.value.id} not found in all_events`);
    }

    const contextEvents = getEventBasicContext(allEvents, event);
    const contextEventIds = new Set(
        contextEvents.map((candidate) => candidate.id.identifier)
    );
    const contextSerializedEvents = serializedEvents.filter((candidate) =>
        contextEventIds.has(candidate.id)
    );

    if (
        oldValue !== undefined &&
        JSON.stringify(oldValue.events) === JSON.stringify(contextSerializedEvents)
    ) {
        return makeUnchanged();
    }

    return { type: "basic_context", events: contextSerializedEvents };
}

module.exports = {
    computeBasicContextForEventId,
};
