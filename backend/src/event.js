/**
 * @typedef Modifiers
 * @type {Record<string, string>}
 */

/**
 * @typedef Event
 * @type {Object}
 * @property {import('./event_id').EventId} id - Unique identifier for the event.
 * @property {string} date - The date of the event.
 * @property {string} original - The original input of the event.
 * @property {string} input - The processed input of the event.
 * @property {Modifiers} modifiers - Modifiers applied to the event.
 * @property {string} type - The type of the event.
 * @property {string} description - A description of the event.
 */

/**
 * Serializes an event object into a JSON string.
 * @param {Event} event - The event object to serialize.
 * @returns {string} - The serialized JSON string representation of the event.
 */
function serialize(event) {
    const realEvent = { ...event, id: event.id.identifier };
    return JSON.stringify(realEvent, null, '\t');
}

module.exports = {
    serialize,
};
