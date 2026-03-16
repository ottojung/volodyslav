const { format } = require("./date");
const eventId = require("./id");
const { fromISOString } = require("../datetime");
const {
    makeMissingFieldError,
    makeInvalidTypeError,
    makeInvalidValueError,
    makeInvalidStructureError,
    makeNestedFieldError,
    makeUnrecognizedFieldError,
} = require("./errors");

/**
 * @typedef {ReturnType<typeof makeMissingFieldError> |
 *           ReturnType<typeof makeInvalidTypeError> |
 *           ReturnType<typeof makeInvalidValueError> |
 *           ReturnType<typeof makeInvalidStructureError> |
 *           ReturnType<typeof makeNestedFieldError> |
 *           ReturnType<typeof makeUnrecognizedFieldError>} TryDeserializeError
 */

/** @typedef {import('../creator').Creator} Creator */

const KNOWN_EVENT_FIELDS = new Set(["id", "date", "original", "input", "creator"]);
const KNOWN_CREATOR_FIELDS = new Set(["name", "uuid", "version", "hostname"]);

/**
 * @typedef Event
 * @type {Object}
 * @property {import('./id').EventId} id - Unique identifier for the event.
 * @property {import('../datetime').DateTime} date - The date of the event.
 * @property {string} original - The original input of the event.
 * @property {string} input - The processed input of the event.
 * @property {Creator} creator - Who created the event.
 */

/**
 * @typedef SerializedEvent
 * @type {Object}
 * @property {string} id - Unique identifier for the event.
 * @property {string} date - The date of the event.
 * @property {string} original - The original input of the event.
 * @property {string} input - The processed input of the event.
 * @property {Creator} creator - Who created the event.
 */

/**
 * @typedef {object} SerializeCapabilities
 * @property {import('../datetime').Datetime} datetime - Datetime capability.
 */

/**
 * @param {SerializeCapabilities} capabilities
 * @param {Event} event - The event object to serialize.
 * @returns {SerializedEvent} - The serialized event object.
 */
function serialize(capabilities, event) {
    const date = format(capabilities, event.date);
    const id = event.id.identifier;
    const { original, input, creator } = event;
    return {
        id,
        date,
        original,
        input,
        creator,
    };
}

/**
 * @param {SerializedEvent} serializedEvent - The serialized event object from JSON.
 * @returns {Event} - The deserialized event object.
 */
function deserialize(serializedEvent) {
    return {
        id: eventId.fromString(serializedEvent.id),
        date: fromISOString(serializedEvent.date),
        original: serializedEvent.original,
        input: serializedEvent.input,
        creator: serializedEvent.creator,
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

        const knownFields = KNOWN_EVENT_FIELDS;
        for (const key of Object.keys(obj)) {
            if (!knownFields.has(key)) {
                return makeUnrecognizedFieldError(key, obj[key]);
            }
        }

        if (!Object.prototype.hasOwnProperty.call(obj, "id")) return makeMissingFieldError("id");
        const id = obj.id;
        if (typeof id !== "string") {
            return makeInvalidTypeError("id", id, "string");
        }

        if (!Object.prototype.hasOwnProperty.call(obj, "date")) return makeMissingFieldError("date");
        const date = obj.date;
        if (typeof date !== "string") {
            return makeInvalidTypeError("date", date, "string");
        }

        if (!Object.prototype.hasOwnProperty.call(obj, "original")) return makeMissingFieldError("original");
        const original = obj.original;
        if (typeof original !== "string") {
            return makeInvalidTypeError("original", original, "string");
        }

        if (!Object.prototype.hasOwnProperty.call(obj, "input")) return makeMissingFieldError("input");
        const input = obj.input;
        if (typeof input !== "string") {
            return makeInvalidTypeError("input", input, "string");
        }

        if (!Object.prototype.hasOwnProperty.call(obj, "creator")) return makeMissingFieldError("creator");
        const creator = obj.creator;
        if (!creator || typeof creator !== "object" || Array.isArray(creator)) {
            return makeInvalidTypeError("creator", creator, "object");
        }

        const knownCreatorFields = KNOWN_CREATOR_FIELDS;
        for (const key of Object.keys(creator)) {
            if (!knownCreatorFields.has(key)) {
                return makeUnrecognizedFieldError(`creator.${key}`, creator[key]);
            }
        }

        const dateObj = fromISOString(date);
        if (!dateObj.isValid) {
            return makeInvalidValueError("date", date, "not a valid date string");
        }

        if (!Object.prototype.hasOwnProperty.call(creator, "name")) {
            return makeNestedFieldError("creator", "name", creator, "missing required field");
        }
        if (!Object.prototype.hasOwnProperty.call(creator, "uuid")) {
            return makeNestedFieldError("creator", "uuid", creator, "missing required field");
        }
        if (!Object.prototype.hasOwnProperty.call(creator, "version")) {
            return makeNestedFieldError("creator", "version", creator, "missing required field");
        }
        if (!Object.prototype.hasOwnProperty.call(creator, "hostname")) {
            return makeNestedFieldError("creator", "hostname", creator, "missing required field");
        }

        const creatorName = creator.name;
        const creatorUuid = creator.uuid;
        const creatorVersion = creator.version;
        const creatorHostname = creator.hostname;
        if (typeof creatorName !== "string") {
            return makeNestedFieldError("creator", "name", creatorName, "expected string");
        }
        if (typeof creatorUuid !== "string") {
            return makeNestedFieldError("creator", "uuid", creatorUuid, "expected string");
        }
        if (typeof creatorVersion !== "string") {
            return makeNestedFieldError("creator", "version", creatorVersion, "expected string");
        }
        if (typeof creatorHostname !== "string") {
            return makeNestedFieldError("creator", "hostname", creatorHostname, "expected string");
        }

        /** @type {SerializedEvent} */
        const validatedSerializedEvent = {
            id: id,
            date: date,
            original: original,
            input: input,
            creator: {
                name: creatorName,
                uuid: creatorUuid,
                version: creatorVersion,
                hostname: creatorHostname,
            },
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
