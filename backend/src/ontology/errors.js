/**
 * Base class for config deserialization errors
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
 * Error for invalid array elements
 */
class InvalidArrayElementError extends TryDeserializeError {
    /**
     * @param {string} arrayField - The array field containing the invalid element
     * @param {number} index - The index of the invalid element
     * @param {unknown} value - The invalid element value
     * @param {string} reason - Why the element is invalid
     */
    constructor(arrayField, index, value, reason) {
        super(
            `Invalid element at index ${index} in '${arrayField}': ${reason}`,
            `${arrayField}[${index}]`,
            value,
            undefined
        );
        this.name = "InvalidArrayElementError";
        this.arrayField = arrayField;
        this.index = index;
        this.reason = reason;
    }
}

/**
 * @param {unknown} object
 * @returns {object is TryDeserializeError}
 */
function isTryDeserializeError(object) {
    return object instanceof TryDeserializeError;
}

/**
 * @param {unknown} object
 * @returns {object is MissingFieldError}
 */
function isMissingFieldError(object) {
    return object instanceof MissingFieldError;
}

/**
 * @param {unknown} object
 * @returns {object is InvalidTypeError}
 */
function isInvalidTypeError(object) {
    return object instanceof InvalidTypeError;
}

/**
 * @param {unknown} object
 * @returns {object is InvalidValueError}
 */
function isInvalidValueError(object) {
    return object instanceof InvalidValueError;
}

/**
 * @param {unknown} object
 * @returns {object is InvalidStructureError}
 */
function isInvalidStructureError(object) {
    return object instanceof InvalidStructureError;
}

/**
 * @param {unknown} object
 * @returns {object is InvalidArrayElementError}
 */
function isInvalidArrayElementError(object) {
    return object instanceof InvalidArrayElementError;
}

/**
 * Factory for InvalidStructureError since it's used outside this module.
 * @param {string} message
 * @param {unknown} value
 * @returns {InvalidStructureError}
 */
function makeInvalidStructureError(message, value) {
    return new InvalidStructureError(message, value);
}

module.exports = {
    TryDeserializeError,
    MissingFieldError,
    InvalidTypeError,
    InvalidValueError,
    InvalidStructureError,
    InvalidArrayElementError,
    makeInvalidStructureError,
    isTryDeserializeError,
    isMissingFieldError,
    isInvalidTypeError,
    isInvalidValueError,
    isInvalidStructureError,
    isInvalidArrayElementError,
};
