const { format } = require("./date");
const eventId = require("./id");
const { fromISOString, isDateTime } = require("../datetime");
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
        for (const [key, value] of Object.entries(obj)) {
            if (!knownFields.has(key)) {
                return makeUnrecognizedFieldError(key, value);
            }
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

        if (!("creator" in obj)) return makeMissingFieldError("creator");
        const creator = obj.creator;
        if (!creator || typeof creator !== "object" || Array.isArray(creator)) {
            return makeInvalidTypeError("creator", creator, "object");
        }

        const knownCreatorFields = KNOWN_CREATOR_FIELDS;
        for (const [key, value] of Object.entries(creator)) {
            if (!knownCreatorFields.has(key)) {
                return makeUnrecognizedFieldError(`creator.${key}`, value);
            }
        }

        const dateObj = fromISOString(date);
        if (!dateObj.isValid) {
            return makeInvalidValueError("date", date, "not a valid date string");
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
        if (!("hostname" in creator)) {
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

/**
 * Check a live `Event` supplied by an in-process producer against the shape a
 * current-version serialized event states.
 *
 * `tryDeserialize` validates the persisted form as text; this checks the live form
 * an in-process producer holds. The event log accepts events from several producers,
 * and one which is not a complete event becomes a computed value the Journal record
 * layer cannot represent, because a current-version serialized event states
 * `original` and `input` as strings.
 *
 * The identifier and the date are accepted in either representation the record layer
 * reads: the nominal `EventId` and `DateTime` a live event carries, and the plain
 * identifier record and Luxon field a persisted event is read back as.
 *
 * The properties that a value passing this check carries are:
 * - `id` states a non-empty string identifier;
 * - `date` is a nominal `DateTime` or states a Luxon date and time string;
 * - `original` and `input` are strings;
 * - `creator` states `name`, `uuid`, `version`, and `hostname` as strings.
 *
 * The proof of those properties is guaranteed by:
 * - `tryValidateEvent(event)`: every property above is checked by an `instanceof`
 *   test for the nominal members or by a `typeof` test for the string members, and a
 *   validation error rather than success is returned when any of them fails.
 *
 * @param {unknown} event
 * @returns {TryDeserializeError | undefined} The reason the event is not complete, or undefined when it is.
 */
function tryValidateEvent(event) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
        return makeInvalidStructureError(
            "Event must be a non-null object and not an array",
            event
        );
    }
    if (!("id" in event)) return makeMissingFieldError("id");
    const id = event.id;
    if (!eventId.isEventId(id) && !(isPlainRecord(id) && typeof id["identifier"] === "string")) {
        return makeInvalidTypeError("id", id, "an EventId");
    }
    if (!("date" in event)) return makeMissingFieldError("date");
    const date = event.date;
    if (!isDateTime(date) && !(isPlainRecord(date) && typeof date["_luxonDateTime"] === "string")) {
        return makeInvalidTypeError("date", date, "a DateTime");
    }
    if (!("original" in event)) return makeMissingFieldError("original");
    if (typeof event.original !== "string") {
        return makeInvalidTypeError("original", event.original, "string");
    }
    if (!("input" in event)) return makeMissingFieldError("input");
    if (typeof event.input !== "string") {
        return makeInvalidTypeError("input", event.input, "string");
    }
    if (!("creator" in event)) return makeMissingFieldError("creator");
    const creator = event.creator;
    if (!isPlainRecord(creator)) {
        return makeInvalidTypeError("creator", creator, "object");
    }
    if (
        !("name" in creator) ||
        !("uuid" in creator) ||
        !("version" in creator) ||
        !("hostname" in creator)
    ) {
        return makeNestedFieldError("creator", "name", creator, "missing required field");
    }
    const { name, uuid, version, hostname } = creator;
    if (typeof name !== "string") {
        return makeNestedFieldError("creator", "name", name, "expected string");
    }
    if (typeof uuid !== "string") {
        return makeNestedFieldError("creator", "uuid", uuid, "expected string");
    }
    if (typeof version !== "string") {
        return makeNestedFieldError("creator", "version", version, "expected string");
    }
    if (typeof hostname !== "string") {
        return makeNestedFieldError("creator", "hostname", hostname, "expected string");
    }
    return undefined;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

module.exports = {
    serialize,
    deserialize,
    tryDeserialize,
    tryValidateEvent,
};
