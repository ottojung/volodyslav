const { deserialize } = require('../../event');

/** @typedef {import('../../event').Event} Event */

/**
 * Encode the stable Event representation used inside persisted ComputedValues.
 * @param {Event} event
 * @returns {import('../incremental_graph/database/types').PersistedEvent}
 */
function eventToPersistedEvent(event) {
    const date = typeof event.date === 'string'
        ? event.date
        : { _luxonDateTime: event.date.toISOString() };
    return {
        id: { identifier: event.id.identifier },
        date,
        original: event.original,
        input: event.input,
        creator: event.creator,
    };
}

/**
 * Decode the stable persisted Event representation into a domain Event.
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
