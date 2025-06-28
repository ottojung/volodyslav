const { format } = require("./date");
const eventId = require("./id");

/**
 * Base class for deserialization errors
 */
class TryDeserializeError extends Error {
    /**
     * @param {string} message - Human readable error message
     * @param {string} field - The field that caused the error
     * @param {unknown} value - The invalid value
     * @param {string} [expectedType] - The expected type/format
     */
    constructor(message, field, value, expectedType) {
        super(message);
        this.name = "TryDeserializeError";
        this.field = field;
        this.value = value;
        this.expectedType = expectedType;
    }
}

/**
 * Error for missing required fields
 */
class MissingFieldError extends TryDeserializeError {
    /**
     * @param {string} field - The missing field name
     */
    constructor(field) {
        super(`Missing required field: ${field}`, field, undefined, "any");
        this.name = "MissingFieldError";
    }
}

/**
 * Error for invalid field types
 */
class InvalidTypeError extends TryDeserializeError {
    /**
     * @param {string} field - The field with invalid type
     * @param {unknown} value - The invalid value
     * @param {string} expectedType - The expected type
     */
    constructor(field, value, expectedType) {
        const actualType = Array.isArray(value) ? 'array' : typeof value;
        super(
            `Invalid type for field '${field}': expected ${expectedType}, got ${actualType}`,
            field,
            value,
            expectedType
        );
        this.name = "InvalidTypeError";
        this.actualType = actualType;
    }
}

/**
 * Error for invalid field values
 */
class InvalidValueError extends TryDeserializeError {
    /**
     * @param {string} field - The field with invalid value
     * @param {unknown} value - The invalid value
     * @param {string} reason - Why the value is invalid
     */
    constructor(field, value, reason) {
        super(`Invalid value for field '${field}': ${reason}`, field, value, undefined);
        this.name = "InvalidValueError";
        this.reason = reason;
    }
}

/**
 * Error for invalid object structure
 */
class InvalidStructureError extends TryDeserializeError {
    /**
     * @param {string} message - Error message
     * @param {unknown} value - The invalid structure
     */
    constructor(message, value) {
        super(message, "root", value, "object");
        this.name = "InvalidStructureError";
    }
}

/**
 * Error for nested field validation failures
 */
class NestedFieldError extends TryDeserializeError {
    /**
     * @param {string} parentField - The parent field containing the nested error
     * @param {string} nestedField - The nested field that failed
     * @param {unknown} value - The invalid value
     * @param {string} reason - Why validation failed
     */
    constructor(parentField, nestedField, value, reason) {
        super(
            `Invalid nested field '${parentField}.${nestedField}': ${reason}`,
            `${parentField}.${nestedField}`,
            value,
            undefined
        );
        this.name = "NestedFieldError";
        this.parentField = parentField;
        this.nestedField = nestedField;
        this.reason = reason;
    }
}

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
 * This function is kept for backward compatibility.
 *
 * @param {unknown} obj - The object to attempt to deserialize
 * @returns {Event | null} - The deserialized Event or null if invalid
 */
function tryDeserialize(obj) {
    try {
        return tryDeserializeWithErrors(obj);
    } catch {
        return null;
    }
}

/**
 * Attempts to deserialize an unknown object into an Event.
 * Returns the Event on success, or throws a TryDeserializeError on failure.
 *
 * @param {unknown} obj - The object to attempt to deserialize
 * @returns {Event} - The deserialized Event
 * @throws {TryDeserializeError} - If the object is not a valid SerializedEvent or deserialization fails
 */
function tryDeserializeWithErrors(obj) {
    try {
        // Basic type and property checks
        if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
            throw new InvalidStructureError(
                "Object must be a non-null object and not an array",
                obj
            );
        }

        // Extract and validate each field individually
        if (!("id" in obj)) throw new MissingFieldError("id");
        const id = obj.id;
        if (typeof id !== "string") {
            throw new InvalidTypeError("id", id, "string");
        }

        if (!("date" in obj)) throw new MissingFieldError("date");
        const date = obj.date;
        if (typeof date !== "string") {
            throw new InvalidTypeError("date", date, "string");
        }

        if (!("original" in obj)) throw new MissingFieldError("original");
        const original = obj.original;
        if (typeof original !== "string") {
            throw new InvalidTypeError("original", original, "string");
        }

        if (!("input" in obj)) throw new MissingFieldError("input");
        const input = obj.input;
        if (typeof input !== "string") {
            throw new InvalidTypeError("input", input, "string");
        }

        if (!("type" in obj)) throw new MissingFieldError("type");
        const type = obj.type;
        if (typeof type !== "string") {
            throw new InvalidTypeError("type", type, "string");
        }

        if (!("description" in obj)) throw new MissingFieldError("description");
        const description = obj.description;
        if (typeof description !== "string") {
            throw new InvalidTypeError("description", description, "string");
        }

        if (!("creator" in obj)) throw new MissingFieldError("creator");
        const creator = obj.creator;
        if (!creator || typeof creator !== "object" || Array.isArray(creator)) {
            throw new InvalidTypeError("creator", creator, "object");
        }

        // Handle modifiers - defaults to {} if missing. When provided it must
        // be an object and not an array. Falsy values like 0 should be
        // considered invalid rather than treated as an empty object.
        const hasModifiers = "modifiers" in obj;
        /** @type {unknown} */
        const rawModifiers = hasModifiers ? obj.modifiers : {};
        if (
            hasModifiers &&
            (rawModifiers === null ||
                typeof rawModifiers !== "object" ||
                Array.isArray(rawModifiers))
        ) {
            throw new InvalidTypeError("modifiers", rawModifiers, "object");
        }
        /** @type {Record<string, unknown>} */
        const modifiers = hasModifiers ? /** @type {Record<string, unknown>} */ (rawModifiers) : {};

        // Manually validate and parse the date
        const dateObj = new Date(date);
        if (isNaN(dateObj.getTime())) {
            throw new InvalidValueError("date", date, "not a valid date string");
        }

        // Manually validate creator has required properties
        if (!creator || typeof creator !== "object") {
            throw new InvalidTypeError("creator", creator, "object");
        }
        if (!("name" in creator)) {
            throw new NestedFieldError("creator", "name", creator, "missing required field");
        }
        if (!("uuid" in creator)) {
            throw new NestedFieldError("creator", "uuid", creator, "missing required field");
        }
        if (!("version" in creator)) {
            throw new NestedFieldError("creator", "version", creator, "missing required field");
        }
        
        const creatorName = creator.name;
        const creatorUuid = creator.uuid;
        const creatorVersion = creator.version;
        if (typeof creatorName !== "string") {
            throw new NestedFieldError("creator", "name", creatorName, "expected string");
        }
        if (typeof creatorUuid !== "string") {
            throw new NestedFieldError("creator", "uuid", creatorUuid, "expected string");
        }
        if (typeof creatorVersion !== "string") {
            throw new NestedFieldError("creator", "version", creatorVersion, "expected string");
        }

        // Manually validate modifiers
        // Build modifiers object manually using Object.entries
        const sourceEntries = Object.entries(modifiers);
        const validatedEntries = [];
        for (let i = 0; i < sourceEntries.length; i++) {
            const entry = sourceEntries[i];
            if (!entry || entry.length !== 2) {
                throw new InvalidValueError("modifiers", modifiers, "invalid entry structure");
            }
            const key = entry[0];
            const value = entry[1];
            if (typeof value !== "string") {
                throw new NestedFieldError("modifiers", key, value, "expected string value");
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
            throw new InvalidValueError("id", id, "failed to deserialize event ID");
        }

        // Create and return the Event object
        return {
            ...validatedSerializedEvent,
            id: eventIdObj,
            date: dateObj,
        };
    } catch (error) {
        // Re-throw TryDeserializeError instances
        if (error instanceof TryDeserializeError) {
            throw error;
        }
        // Wrap any other errors (e.g., from eventId.deserialize) in InvalidValueError
        throw new InvalidValueError(
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
    tryDeserializeWithErrors,
    TryDeserializeError,
    MissingFieldError,
    InvalidTypeError,
    InvalidValueError,
    InvalidStructureError,
    NestedFieldError,
};
