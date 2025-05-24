const { format } = require("./date");
const eventId = require("./id");

/**
 * @typedef Modifiers
 * @type {Record<string, string>}
 */

/** @typedef {import('../creator').Creator} Creator */

/**
 * @typedef Event
 * @type {Object}
 * @property {import('./id').EventId} id - Unique identifier for the event.
 * @property {Date} date - The date of the event.
 * @property {string} original - The original input of the event.
 * @property {string} input - The processed input of the event.
 * @property {Modifiers} modifiers - Modifiers applied to the event.
 * @property {string} type - The type of the event.
 * @property {string} description - A description of the event.
 * @property {Creator} creator - Who created the event.
 */

/**
 * @typedef SerializedEvent
 * @type {Object}
 * @property {string} id - Unique identifier for the event.
 * @property {string} date - The date of the event.
 * @property {string} original - The original input of the event.
 * @property {string} input - The processed input of the event.
 * @property {Modifiers} modifiers - Modifiers applied to the event.
 * @property {string} type - The type of the event.
 * @property {string} description - A description of the event.
 * @property {Creator} creator - Who created the event.
 */

/**
 * @param {Event} event - The event object to serialize.
 * @returns {SerializedEvent} - The serialized event object.
 */
function serialize(event) {
    // De-nominalize the event.
    const date = format(event.date);
    const id = event.id.identifier;
    const realEvent = { ...event, date, id };
    return realEvent;
}

/**
 * @param {SerializedEvent} serializedEvent - The serialized event object from JSON.
 * @returns {Event} - The deserialized event object.
 */
function deserialize(serializedEvent) {
    return {
        ...serializedEvent,
        id: eventId.deserialize(serializedEvent),
        date: new Date(serializedEvent.date),
    };
}

module.exports = {
    serialize,
    deserialize,
};
