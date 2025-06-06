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
 * @property {string} description - A description of the event (required).
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
 * @property {string} description - A description of the event (required).
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

        // Extract and validate each field individually
        if (!("id" in obj)) return null;
        const id = obj.id;
        if (typeof id !== "string") {
            return null;
        }

        if (!("date" in obj)) return null;
        const date = obj.date;
        if (typeof date !== "string") {
            return null;
        }

        if (!("original" in obj)) return null;
        const original = obj.original;
        if (typeof original !== "string") {
            return null;
        }

        if (!("input" in obj)) return null;
        const input = obj.input;
        if (typeof input !== "string") {
            return null;
        }

        if (!("type" in obj)) return null;
        const type = obj.type;
        if (typeof type !== "string") {
            return null;
        }

        if (!("description" in obj)) return null;
        const description = obj.description;
        if (typeof description !== "string") {
            return null;
        }

        if (!("creator" in obj)) return null;
        const creator = obj.creator;
        if (!creator || typeof creator !== "object" || Array.isArray(creator)) {
            return null;
        }

        // Handle modifiers - defaults to {} if missing, must be a non-array object if present
        const rawModifiers = "modifiers" in obj ? obj.modifiers : {};
        const modifiers = rawModifiers || {};
        if (typeof modifiers !== "object" || Array.isArray(modifiers)) {
            return null;
        }

        // Manually validate and parse the date
        const dateObj = new Date(date);
        if (isNaN(dateObj.getTime())) {
            return null;
        }

        // Manually validate creator has required properties
        if (!creator || typeof creator !== "object") {
            return null;
        }
        if (
            !("name" in creator) ||
            !("uuid" in creator) ||
            !("version" in creator)
        ) {
            return null;
        }
        const creatorName = creator.name;
        const creatorUuid = creator.uuid;
        const creatorVersion = creator.version;
        if (
            typeof creatorName !== "string" ||
            typeof creatorUuid !== "string" ||
            typeof creatorVersion !== "string"
        ) {
            return null;
        }

        // Manually validate modifiers
        // Build modifiers object manually using Object.entries
        const sourceEntries = Object.entries(modifiers);
        const validatedEntries = [];
        for (let i = 0; i < sourceEntries.length; i++) {
            const entry = sourceEntries[i];
            if (!entry || entry.length !== 2) {
                return null;
            }
            const key = entry[0];
            const value = entry[1];
            if (typeof value !== "string") {
                return null;
            }
            validatedEntries.push([key, value]);
        }
        const validatedModifiers = Object.fromEntries(validatedEntries);

        // Create validated SerializedEvent object for eventId.deserialize
        /** @type {SerializedEvent} */
        const validatedSerializedEvent = {
            id: id,
            date: date,
            original: original,
            input: input,
            type: type,
            description: description,
            creator: {
                name: creatorName,
                uuid: creatorUuid,
                version: creatorVersion,
            },
            modifiers: validatedModifiers,
        };
        const eventIdObj = eventId.deserialize(validatedSerializedEvent);
        if (!eventIdObj || !eventIdObj.identifier) {
            return null;
        }

        // Create and return the Event object
        return {
            ...validatedSerializedEvent,
            id: eventIdObj,
            date: dateObj,
        };
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
