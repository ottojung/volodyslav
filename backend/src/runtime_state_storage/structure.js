/**
 * Runtime state structure and validation.
 */

/**
 * @typedef {import('./types').RuntimeState} RuntimeState
 */

/**
 * Base class for runtime state deserialization errors.
 */
class TryDeserializeError extends Error {
    /**
     * @param {string} message
     * @param {string} field
     * @param {unknown} value
     * @param {string} expectedType
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
 * Error thrown when a required field is missing from the runtime state.
 */
class MissingFieldError extends TryDeserializeError {
    /**
     * @param {string} field
     */
    constructor(field) {
        super(`Missing required field: ${field}`, field, undefined, "any");
        this.name = "MissingFieldError";
    }
}

/**
 * Error thrown when a field has an invalid type.
 */
class InvalidTypeError extends TryDeserializeError {
    /**
     * @param {string} field
     * @param {unknown} value
     * @param {string} expectedType
     */
    constructor(field, value, expectedType) {
        const actualType = Array.isArray(value) ? 'array' : typeof value;
        super(`Invalid type for field '${field}': expected ${expectedType}, got ${actualType}`, 
              field, value, expectedType);
        this.name = "InvalidTypeError";
        this.actualType = actualType;
    }
}

/**
 * Error thrown when the runtime state structure is invalid.
 */
class InvalidStructureError extends TryDeserializeError {
    /**
     * @param {string} message
     * @param {unknown} value
     */
    constructor(message, value) {
        super(message, "root", value, "object");
        this.name = "InvalidStructureError";
    }
}

/**
 * Type guard for TryDeserializeError.
 * @param {unknown} object
 * @returns {object is TryDeserializeError}
 */
function isTryDeserializeError(object) {
    return object instanceof TryDeserializeError;
}

/**
 * Attempts to deserialize an object into a RuntimeState.
 * @param {unknown} obj - The object to deserialize.
 * @returns {RuntimeState | TryDeserializeError}
 */
function tryDeserialize(obj) {
    if (!obj || typeof obj !== "object") {
        return new InvalidStructureError("Runtime state must be a non-null object", obj);
    }
    
    if (!("startTime" in obj)) {
        return new MissingFieldError("startTime");
    }
    
    if (typeof obj.startTime !== "string") {
        return new InvalidTypeError("startTime", obj.startTime, "string");
    }
    
    try {
        const datetime = require("../datetime");
        const datetimeCaps = datetime.make();
        const startTime = datetimeCaps.fromISOString(obj.startTime);
        
        // Check if the parsed DateTime is valid
        if (isNaN(startTime.getTime())) {
            return new InvalidTypeError("startTime", obj.startTime, "valid ISO string");
        }
        
        return {
            startTime: startTime
        };
    } catch (error) {
        return new InvalidTypeError("startTime", obj.startTime, "valid ISO string");
    }
}

/**
 * Serializes a RuntimeState object to a plain object.
 * @param {RuntimeState} state - The runtime state to serialize.
 * @returns {object}
 */
function serialize(state) {
    const datetime = require("../datetime");
    const datetimeCaps = datetime.make();
    return {
        startTime: datetimeCaps.toISOString(state.startTime)
    };
}

/**
 * Creates a new RuntimeState with the current time as start time.
 * @param {import('../datetime').Datetime} datetime - Datetime capabilities.
 * @returns {RuntimeState}
 */
function makeDefault(datetime) {
    return {
        startTime: datetime.now()
    };
}

module.exports = {
    tryDeserialize,
    serialize,
    makeDefault,
    isTryDeserializeError,
    TryDeserializeError,
    MissingFieldError,
    InvalidTypeError,
    InvalidStructureError
};
