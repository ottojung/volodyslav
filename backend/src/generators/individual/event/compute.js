/**
 * Compute the full event structure for a given event ID.
 */

/** @typedef {import('../../../event').Event} Event */
/** @typedef {import('../../incremental_graph/database/types').EventEntry} EventEntry */

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
 * Finds and returns the full event with the given ID from the events array.
 *
 * @param {string} eventId - The event ID to look up
 * @param {Array<Event>} events - The current set of all events
 * @returns {EventEntry}
 * @throws {EventNotFoundError} when no event with that ID exists
 */
function computeEventForId(eventId, events) {
    const value = events.find(
        (e) => String(e.id && e.id.identifier !== undefined ? e.id.identifier : e.id) === eventId
    );
    if (value === undefined) {
        throw new EventNotFoundError(eventId);
    }
    return { type: "event", value };
}

module.exports = {
    computeEventForId,
    isEventNotFoundError,
};
