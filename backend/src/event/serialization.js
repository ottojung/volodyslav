const { format } = require("./date");
const eventId = require("./id");
const { fromISOString } = require("../datetime");
const {
    makeMissingFieldError,
    makeInvalidTypeError,
    makeInvalidValueError,
    makeInvalidStructureError,
    makeNestedFieldError,
} = require("./errors");

/**
 * @typedef {ReturnType<typeof makeMissingFieldError> |
 *           ReturnType<typeof makeInvalidTypeError> |
 *           ReturnType<typeof makeInvalidValueError> |
 *           ReturnType<typeof makeInvalidStructureError> |
 *           ReturnType<typeof makeNestedFieldError>} TryDeserializeError
 */

/**
 * @typedef Modifiers
 * @type {Record<string, string>}
 */

/** @typedef {import('../creator').Creator} Creator */

/**
 * @typedef Event
 * @type {Object}
 * @property {import('./id').EventId} id - Unique identifier for the event.
 * @property {import('../datetime').DateTime} date - The date of the event.
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
    const date = format(event.date);
    const id = event.id.identifier;
    const { original, input, modifiers, type, description, creator } = event;
    return {
        id,
        date,
        original,
        input,
        modifiers,
        type,
        description,
        creator,
    };
}

/**
 * @param {SerializedEvent} serializedEvent - The serialized event object from JSON.
 * @returns {Event} - The deserialized event object.
 */
function deserialize(serializedEvent) {
    return {
        ...serializedEvent,
        id: eventId.fromString(serializedEvent.id),
        date: fromISOString(serializedEvent.date),
        modifiers: serializedEvent.modifiers || {},
    };
}

/**
 * Attempts to deserialize an unknown object into an Event.
 * Returns the Event on success, or a TryDeserializeError on failure.
 *
 * @param {unknown} obj - The object to attempt to deserialize
 * @returns {Event | TryDeserializeError} - The deserialized Event or error object
 */
function tryDeserialize(obj) {
    try {
        if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
            return makeInvalidStructureError(
                "Object must be a non-null object and not an array",
                obj
            );
        }

        if (!("id" in obj)) return makeMissingFieldError("id");
        const id = obj.id;
        if (typeof id !== "string") {
            return makeInvalidTypeError("id", id, "string");
        }

        if (!("date" in obj)) return makeMissingFieldError("date");
        const date = obj.date;
        if (typeof date !== "string") {
            return makeInvalidTypeError("date", date, "string");
        }

        if (!("original" in obj)) return makeMissingFieldError("original");
        const original = obj.original;
        if (typeof original !== "string") {
            return makeInvalidTypeError("original", original, "string");
        }

        if (!("input" in obj)) return makeMissingFieldError("input");
        const input = obj.input;
        if (typeof input !== "string") {
            return makeInvalidTypeError("input", input, "string");
        }

        if (!("type" in obj)) return makeMissingFieldError("type");
        const type = obj.type;
        if (typeof type !== "string") {
            return makeInvalidTypeError("type", type, "string");
        }

        if (!("description" in obj)) return makeMissingFieldError("description");
        const description = obj.description;
        if (typeof description !== "string") {
            return makeInvalidTypeError("description", description, "string");
        }

        if (!("creator" in obj)) return makeMissingFieldError("creator");
        const creator = obj.creator;
        if (!creator || typeof creator !== "object" || Array.isArray(creator)) {
            return makeInvalidTypeError("creator", creator, "object");
        }

        const hasModifiers = "modifiers" in obj;
        const rawModifiers = hasModifiers ? obj.modifiers : {};
        if (rawModifiers === null || typeof rawModifiers !== "object" || Array.isArray(rawModifiers)) {
            return makeInvalidTypeError("modifiers", rawModifiers, "object");
        }

        /** @type {Record<string, unknown>} */
        let modifiers = {};
        for (const [key, value] of Object.entries(rawModifiers)) {
            if (typeof value !== "string") {
                return makeNestedFieldError("modifiers", key, value, "expected string value");
            }
            modifiers[key] = value;
        }

        const dateObj = fromISOString(date);
        if (!dateObj._luxonDateTime.isValid) {
            return makeInvalidValueError("date", date, "not a valid date string");
        }

        if (!creator || typeof creator !== "object") {
            return makeInvalidTypeError("creator", creator, "object");
        }
        if (!("name" in creator)) {
            return makeNestedFieldError("creator", "name", creator, "missing required field");
        }
        if (!("uuid" in creator)) {
            return makeNestedFieldError("creator", "uuid", creator, "missing required field");
        }
        if (!("version" in creator)) {
            return makeNestedFieldError("creator", "version", creator, "missing required field");
        }

        const creatorName = creator.name;
        const creatorUuid = creator.uuid;
        const creatorVersion = creator.version;
        if (typeof creatorName !== "string") {
            return makeNestedFieldError("creator", "name", creatorName, "expected string");
        }
        if (typeof creatorUuid !== "string") {
            return makeNestedFieldError("creator", "uuid", creatorUuid, "expected string");
        }
        if (typeof creatorVersion !== "string") {
            return makeNestedFieldError("creator", "version", creatorVersion, "expected string");
        }

        const sourceEntries = Object.entries(modifiers);
        const validatedEntries = [];
        for (let i = 0; i < sourceEntries.length; i++) {
            const entry = sourceEntries[i];
            if (!entry || entry.length !== 2) {
                return makeInvalidValueError("modifiers", modifiers, "invalid entry structure");
            }
            const key = entry[0];
            const value = entry[1];
            if (typeof value !== "string") {
                return makeNestedFieldError("modifiers", key, value, "expected string value");
            }
            validatedEntries.push([key, value]);
        }
        const validatedModifiers = Object.fromEntries(validatedEntries);

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

        const eventIdObj = eventId.fromString(validatedSerializedEvent.id);
        if (!eventIdObj || !eventIdObj.identifier) {
            return makeInvalidValueError("id", id, "failed to deserialize event ID");
        }

        return {
            ...validatedSerializedEvent,
            id: eventIdObj,
            date: dateObj,
        };
    } catch (error) {
        return makeInvalidValueError(
            "unknown",
            obj,
            `Unexpected error during deserialization: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

module.exports = {
    serialize,
    deserialize,
    tryDeserialize,
};
