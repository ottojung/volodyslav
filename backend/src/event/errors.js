/**
 * Error classes and helpers for event deserialization.
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

class MissingFieldError extends TryDeserializeError {
    /**
     * @param {string} field - The missing field name
     */
    constructor(field) {
        super(`Missing required field: ${field}`, field, undefined, "any");
        this.name = "MissingFieldError";
    }
}

class InvalidTypeError extends TryDeserializeError {
    /**
     * @param {string} field - The field with invalid type
     * @param {unknown} value - The invalid value
     * @param {string} expectedType - The expected type
     */
    constructor(field, value, expectedType) {
        const actualType = Array.isArray(value) ? "array" : typeof value;
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
 * @param {string} field
 * @returns {MissingFieldError}
 */
function makeMissingFieldError(field) {
    return new MissingFieldError(field);
}

/**
 * @param {string} field
 * @param {unknown} value
 * @param {string} expectedType
 * @returns {InvalidTypeError}
 */
function makeInvalidTypeError(field, value, expectedType) {
    return new InvalidTypeError(field, value, expectedType);
}

/**
 * @param {string} field
 * @param {unknown} value
 * @param {string} reason
 * @returns {InvalidValueError}
 */
function makeInvalidValueError(field, value, reason) {
    return new InvalidValueError(field, value, reason);
}

/**
 * @param {string} message
 * @param {unknown} value
 * @returns {InvalidStructureError}
 */
function makeInvalidStructureError(message, value) {
    return new InvalidStructureError(message, value);
}

/**
 * @param {string} parentField
 * @param {string} nestedField
 * @param {unknown} value
 * @param {string} reason
 * @returns {NestedFieldError}
 */
function makeNestedFieldError(parentField, nestedField, value, reason) {
    return new NestedFieldError(parentField, nestedField, value, reason);
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
 * @returns {object is NestedFieldError}
 */
function isNestedFieldError(object) {
    return object instanceof NestedFieldError;
}

module.exports = {
    makeMissingFieldError,
    makeInvalidTypeError,
    makeInvalidValueError,
    makeInvalidStructureError,
    makeNestedFieldError,
    isTryDeserializeError,
    isMissingFieldError,
    isInvalidTypeError,
    isInvalidValueError,
    isInvalidStructureError,
    isNestedFieldError,
};
