/**
 * Error classes for runtime state deserialization.
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

class MissingFieldError extends TryDeserializeError {
    /**
     * @param {string} field
     */
    constructor(field) {
        super(`Missing required field: ${field}`, field, undefined, "any");
        this.name = "MissingFieldError";
    }
}

class InvalidTypeError extends TryDeserializeError {
    /**
     * @param {string} field
     * @param {unknown} value
     * @param {string} expectedType
     */
    constructor(field, value, expectedType) {
        const actualType = Array.isArray(value) ? "array" : typeof value;
        super(`Invalid type for field '${field}': expected ${expectedType}, got ${actualType}`, field, value, expectedType);
        this.name = "InvalidTypeError";
        this.actualType = actualType;
    }
}

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

class TasksFieldInvalidStructureError extends TryDeserializeError {
    /**
     * @param {unknown} value
     */
    constructor(value) {
        super("Tasks field must be an array", "tasks", value, "array");
        this.name = "TasksFieldInvalidStructureError";
    }
}

class UnsupportedVersionError extends TryDeserializeError {
    /**
     * @param {number} version
     */
    constructor(version) {
        super(`Unsupported runtime state version: ${version}`, "version", version, "2");
        this.name = "UnsupportedVersionError";
        this.version = version;
    }
}

class TryDeserializeTaskError extends TryDeserializeError {
    /**
     * @param {string} message
     * @param {string} field
     * @param {unknown} value
     * @param {string} expectedType
     * @param {number} index
     */
    constructor(message, field, value, expectedType, index) {
        super(message, field, value, expectedType);
        this.name = "TryDeserializeTaskError";
        this.taskIndex = index;
    }
}

class TaskMissingFieldError extends TryDeserializeTaskError {
    /**
     * @param {string} field
     * @param {number} index
     */
    constructor(field, index) {
        super(`Missing required field '${field}' in task`, field, undefined, "any", index);
        this.name = "TaskMissingFieldError";
    }
}

class TaskInvalidTypeError extends TryDeserializeTaskError {
    /**
     * @param {string} field
     * @param {unknown} value
     * @param {string} expectedType
     * @param {number} index
     */
    constructor(field, value, expectedType, index) {
        const actualType = Array.isArray(value) ? "array" : typeof value;
        super(`Invalid type for field '${field}': expected ${expectedType}, got ${actualType}`, field, value, expectedType, index);
        this.name = "TaskInvalidTypeError";
        this.actualType = actualType;
    }
}

class TaskInvalidValueError extends TryDeserializeTaskError {
    /**
     * @param {string} field
     * @param {unknown} value
     * @param {string} expectedType
     * @param {number} index
     */
    constructor(field, value, expectedType, index) {
        super(`Invalid value for field '${field}'`, field, value, expectedType, index);
        this.name = "TaskInvalidValueError";
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
 * @returns {object is TryDeserializeTaskError}
 */
function isTryDeserializeTaskError(object) {
    return object instanceof TryDeserializeTaskError;
}

class RuntimeStateFileParseError extends Error {
    /**
     * @param {string} message
     * @param {string} filepath
     * @param {Error} cause
     */
    constructor(message, filepath, cause) {
        super(message);
        this.name = "RuntimeStateFileParseError";
        this.filepath = filepath;
        this.cause = cause;
    }
}

class RuntimeStateCorruptedError extends Error {
    /**
     * @param {TryDeserializeError} deserializeError
     * @param {string} filepath
     */
    constructor(deserializeError, filepath) {
        super(`Runtime state file is corrupted: ${deserializeError.message}`);
        this.name = "RuntimeStateCorruptedError";
        this.filepath = filepath;
        this.deserializeError = deserializeError;
    }
}

/**
 * @param {unknown} object
 * @returns {object is RuntimeStateFileParseError}
 */
function isRuntimeStateFileParseError(object) {
    return object instanceof RuntimeStateFileParseError;
}

/**
 * @param {unknown} object
 * @returns {object is RuntimeStateCorruptedError}
 */
function isRuntimeStateCorruptedError(object) {
    return object instanceof RuntimeStateCorruptedError;
}

module.exports = {
    TryDeserializeError,
    MissingFieldError,
    InvalidTypeError,
    InvalidStructureError,
    TasksFieldInvalidStructureError,
    UnsupportedVersionError,
    TryDeserializeTaskError,
    TaskMissingFieldError,
    TaskInvalidTypeError,
    TaskInvalidValueError,
    RuntimeStateFileParseError,
    RuntimeStateCorruptedError,
    isTryDeserializeError,
    isTryDeserializeTaskError,
    isRuntimeStateFileParseError,
    isRuntimeStateCorruptedError,
};
