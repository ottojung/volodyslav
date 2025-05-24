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
        modifiers: serializedEvent.modifiers || {},
    };
}

/**
 * Attempts to deserialize an unknown object into an Event.
 * Returns null if the object is not a valid SerializedEvent or if deserialization fails.
 * 
 * @param {unknown} obj - The object to attempt to deserialize
 * @returns {Event | null} - The deserialized Event or null if invalid
 */
function tryDeserialize(obj) {
    try {
        // Basic type and property checks
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
            return null;
        }

        const candidate = /** @type {Record<string, unknown>} */ (obj);

        // Check all required properties exist and have correct types
        if (
            typeof candidate['id'] !== 'string' ||
            typeof candidate['date'] !== 'string' ||
            typeof candidate['original'] !== 'string' ||
            typeof candidate['input'] !== 'string' ||
            typeof candidate['type'] !== 'string' ||
            typeof candidate['description'] !== 'string' ||
            !candidate['creator'] ||
            typeof candidate['creator'] !== 'object' ||
            Array.isArray(candidate['creator'])
        ) {
            return null;
        }

        // Check modifiers - it can be missing (will default to {}) or must be a non-array object
        if (candidate['modifiers'] !== undefined && 
            (typeof candidate['modifiers'] !== 'object' || Array.isArray(candidate['modifiers']))) {
            return null;
        }

        // Attempt to deserialize - this will validate EventId and Date parsing
        const serializedEvent = /** @type {SerializedEvent} */ (candidate);
        return deserialize(serializedEvent);
    } catch {
        // Any error in deserialization (invalid EventId, invalid Date, etc.) returns null
        return null;
    }
}

module.exports = {
    serialize,
    deserialize,
    tryDeserialize,
};
