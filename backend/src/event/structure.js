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
        if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
            return null;
        }

        const candidate = /** @type {Record<string, unknown>} */ (obj);

        // Extract and validate each field individually
        const id = candidate["id"];
        if (typeof id !== "string") {
            return null;
        }

        const date = candidate["date"];
        if (typeof date !== "string") {
            return null;
        }

        const original = candidate["original"];
        if (typeof original !== "string") {
            return null;
        }

        const input = candidate["input"];
        if (typeof input !== "string") {
            return null;
        }

        const type = candidate["type"];
        if (typeof type !== "string") {
            return null;
        }

        const description = candidate["description"];
        if (typeof description !== "string") {
            return null;
        }

        const creator = candidate["creator"];
        if (!creator || typeof creator !== "object" || Array.isArray(creator)) {
            return null;
        }

        // Handle modifiers - can be missing (defaults to {}) or must be a non-array object
        const modifiers = candidate["modifiers"];
        if (
            modifiers !== undefined &&
            (typeof modifiers !== "object" || Array.isArray(modifiers))
        ) {
            return null;
        }

        // Create SerializedEvent object explicitly with validated fields
        /** @type {SerializedEvent} */
        const serializedEvent = {
            id: id,
            date: date,
            original: original,
            input: input,
            type: type,
            description: description,
            creator: /** @type {Creator} */ (creator),
            modifiers: /** @type {Modifiers} */ (modifiers || {}),
        };

        // Attempt to deserialize - this will validate EventId and Date parsing
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
