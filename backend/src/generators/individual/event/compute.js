/**
 * Compute the full event structure for a given event ID.
 */

/** @typedef {import('../../../event').Event} Event */
/** @typedef {import('../../incremental_graph/database/types').EventEntry} EventEntry */

/**
 * Finds and returns the full event with the given ID from the events array.
 *
 * @param {string} eventId - The event ID to look up
 * @param {Array<Event>} events - The current set of all events
 * @returns {EventEntry}
 */
function computeEventForId(eventId, events) {
    const value = events.find(
        (e) => String(e.id && e.id.identifier !== undefined ? e.id.identifier : e.id) === eventId
    );
    if (value === undefined) {
        throw new Error(`Event with ID ${eventId} not found in all_events`);
    }
    return { type: "event", value };
}

module.exports = {
    computeEventForId,
};
