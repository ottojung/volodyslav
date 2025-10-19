

/** @typedef {import('./structure').DateTime} DateTime */

const { fromLuxon, isDateTime } = require('./structure');
const { DateTime: LuxonDateTime } = require("luxon");

/**
 * @param {string} iso
 * @returns {DateTime}
 */
function fromISOString(iso) {
    return fromLuxon(LuxonDateTime.fromISO(iso, { zone: 'utc' }));
}

/**
 * @param {DateTime} dt
 * @returns {string}
 */
function toISOString(dt) {
    return dt.toISOString();
}

/**
 * Gets the modification time of a file from its stats.
 * @param {import('fs').Stats} stats - The file stats object.
 * @returns {DateTime} - The modification time as a DateTime object.
 */
function mtime(stats) {
    return fromLuxon(LuxonDateTime.fromJSDate(stats.mtime));
}

/**
 * Error for invalid DateTime deserialization.
 */
class DateTimeTryDeserializeError extends Error {
    /**
     * @param {string} message
     * @param {unknown} value
     */
    constructor(message, value) {
        super(message);
        this.name = "DateTimeTryDeserializeError";
        this.value = value;
    }
}

/**
 * @param {unknown} object
 * @returns {object is DateTimeTryDeserializeError}
 */
function isDateTimeTryDeserializeError(object) {
    return object instanceof DateTimeTryDeserializeError;
}

/**
 * Attempt to deserialize an unknown value into a DateTime.
 * This handles various input formats that could represent a DateTime:
 * - DateTime objects (pass through)
 * - ISO string representations
 * - Plain objects from JSON parsing
 * 
 * @param {unknown} value - The value to attempt to deserialize
 * @returns {DateTime | DateTimeTryDeserializeError} - The DateTime or error object
 */
function tryDeserialize(value) {
    // Handle null/undefined
    if (value === null) {
        return new DateTimeTryDeserializeError("DateTime cannot be null", value);
    }
    if (value === undefined) {
        return new DateTimeTryDeserializeError("DateTime cannot be undefined", value);
    }

    // If it's already a DateTime object, return it
    if (isDateTime(value)) {
        return value;
    }

    // If it's a string, try to parse as ISO string
    if (typeof value === "string") {
        try {
            const luxonDateTime = LuxonDateTime.fromISO(value, { zone: 'utc' });
            if (!luxonDateTime.isValid) {
                return new DateTimeTryDeserializeError(
                    `Invalid ISO string: ${luxonDateTime.invalidReason || 'unknown reason'}`,
                    value
                );
            }
            return fromLuxon(luxonDateTime);
        } catch (error) {
            return new DateTimeTryDeserializeError(
                `Failed to parse ISO string: ${error instanceof Error ? error.message : String(error)}`,
                value
            );
        }
    }

    // If it's an object (could be from JSON parsing), try to reconstruct
    if (typeof value === "object" && value !== null) {
        // Check if it looks like a serialized DateTime object
        if ("_luxonDateTime" in value && typeof value._luxonDateTime === "string") {
            try {
                const luxonDateTime = LuxonDateTime.fromISO(value._luxonDateTime, { zone: 'utc' });
                if (!luxonDateTime.isValid) {
                    return new DateTimeTryDeserializeError(
                        `Invalid DateTime object with invalid ISO string: ${luxonDateTime.invalidReason || 'unknown reason'}`,
                        value
                    );
                }
                return fromLuxon(luxonDateTime);
            } catch (error) {
                return new DateTimeTryDeserializeError(
                    `Failed to parse DateTime object: ${error instanceof Error ? error.message : String(error)}`,
                    value
                );
            }
        }

        // Check if it looks like a plain object with ISO string representation
        if ("toISOString" in value && typeof value.toISOString === "function") {
            try {
                const isoString = value.toISOString();
                return tryDeserialize(isoString);
            } catch (error) {
                return new DateTimeTryDeserializeError(
                    `Failed to get ISO string from object: ${error instanceof Error ? error.message : String(error)}`,
                    value
                );
            }
        }
    }

    // Unsupported type
    const actualType = Array.isArray(value) ? 'array' : typeof value;
    return new DateTimeTryDeserializeError(
        `Cannot deserialize ${actualType} to DateTime`,
        value
    );
}

module.exports = {    
    fromISOString,
    toISOString,
    mtime,
    tryDeserialize,
    DateTimeTryDeserializeError,
    isDateTimeTryDeserializeError,
};
