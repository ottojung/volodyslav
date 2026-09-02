const { deserialize } = require('../../event');

/** @typedef {import('../../event').Event} Event */

/**
 * Produce the plain JSON record that ordinary persistence historically wrote
 * for an Event instance. In particular, the event identifier remains the
 * record `{ identifier }` rather than becoming a string.
 * @param {Event} event
 * @returns {import('../incremental_graph/database/types').PersistedEvent}
 */
function eventToPersistedEvent(event) {
    return JSON.parse(JSON.stringify(event));
}

/**
 * Reconstruct an Event from its historical persisted JSON record.
 * @param {import('../incremental_graph/database/types').PersistedEvent} event
 * @returns {Event}
 */
function persistedEventToEvent(event) {
    const date = typeof event.date === 'string'
        ? event.date
        : event.date._luxonDateTime;
    return deserialize({
        id: event.id.identifier,
        date,
        original: event.original,
        input: event.input,
        creator: event.creator,
    });
}

module.exports = { eventToPersistedEvent, persistedEventToEvent };
