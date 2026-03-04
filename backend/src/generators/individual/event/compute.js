/**
 * Compute the full event structure for a given event ID.
 */

/** @typedef {import('../../../event').Event} Event */
/** @typedef {import('../../incremental_graph/database/types').EventEntry} EventEntry */

/**
 * Finds and returns the full event with the given ID from the events array.
 *
 * Returns `{ type: "event", value: null }` when no event with that ID exists,
 * indicating the ID is unknown rather than throwing.
 *
 * @param {string} eventId - The event ID to look up
 * @param {Array<Event>} events - The current set of all events
 * @returns {EventEntry}
 */
function computeEventForId(eventId, events) {
    const value = events.find(
        (e) => String(e.id && e.id.identifier !== undefined ? e.id.identifier : e.id) === eventId
    ) ?? null;
    return { type: "event", value };
}

module.exports = {
    computeEventForId,
};
