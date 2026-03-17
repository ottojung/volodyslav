/**
 * Compute the full event structure for a given event ID.
 */

const { makeUnchanged } = require('../../incremental_graph');

/** @typedef {import('../../../event').SerializedEvent} SerializedEvent */
/** @typedef {import('../../incremental_graph/database/types').EventEntry} EventEntry */
/** @typedef {import('../../incremental_graph/unchanged').Unchanged} Unchanged */

/**
 * Thrown by computeEventForId when no event with the requested ID exists.
 */
class EventNotFoundError extends Error {
    /**
     * @param {string} eventId
     */
    constructor(eventId) {
        super(`Event with ID ${eventId} not found in all_events`);
        this.name = "EventNotFoundError";
        this.eventId = eventId;
    }
}

/**
 * @param {unknown} object
 * @returns {object is EventNotFoundError}
 */
function isEventNotFoundError(object) {
    return object instanceof EventNotFoundError;
}

/**
 * Finds and returns the serialized event with the given ID from the events array.
 *
 * @param {string} eventId - The event ID to look up
 * @param {Array<SerializedEvent>} events - The current set of all serialized events
 * @returns {SerializedEvent}
 * @throws {EventNotFoundError} when no event with that ID exists
 */
function getSerializedEventForIdOrThrow(eventId, events) {
    const value = events.find((event) => event.id === eventId);
    if (value === undefined) {
        throw new EventNotFoundError(eventId);
    }
    return value;
}

/**
 * Finds and returns the serialized event entry with the given ID from the events array.
 *
 * @param {string} eventId - The event ID to look up
 * @param {EventEntry | undefined} oldValue - The previous value of the event entry, used for optimization
 * @param {Array<SerializedEvent>} events - The current set of all serialized events
 * @returns {EventEntry | Unchanged}
 * @throws {EventNotFoundError} when no event with that ID exists
 */
function computeEventForId(eventId, oldValue, events) {
    const value = getSerializedEventForIdOrThrow(eventId, events);
    if (oldValue !== undefined && JSON.stringify(value) === JSON.stringify(oldValue.value)) {
        return makeUnchanged();
    }
    return { type: "event", value };
}

module.exports = {
    computeEventForId,
    getSerializedEventForIdOrThrow,
    isEventNotFoundError,
};
