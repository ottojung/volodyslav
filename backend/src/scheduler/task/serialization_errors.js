/**
 * Task serialization/deserialization error classes.
 */

/**
 * Base class for task deserialization errors.
 */
class TaskTryDeserializeError extends Error {
    /**
     * @param {string} message
     * @param {string} field
     * @param {unknown} value
     * @param {string} expectedType
     */
    constructor(message, field, value, expectedType) {
        super(message);
        this.name = "TaskTryDeserializeError";
        this.field = field;
        this.value = value;
        this.expectedType = expectedType;
    }
}

/**
 * Error for missing required fields.
 */
class TaskMissingFieldError extends TaskTryDeserializeError {
    /**
     * @param {string} field
     */
    constructor(field) {
        super(`Missing required field: ${field}`, field, undefined, "any");
        this.name = "TaskMissingFieldError";
    }
}

/**
 * Error for invalid field types.
 */
class TaskInvalidTypeError extends TaskTryDeserializeError {
    /**
     * @param {string} field
     * @param {unknown} value
     * @param {string} expectedType
     */
    constructor(field, value, expectedType) {
        const actualType = Array.isArray(value) ? 'array' : typeof value;
        super(`Invalid type for field '${field}': expected ${expectedType}, got ${actualType}`, 
              field, value, expectedType);
        this.name = "TaskInvalidTypeError";
        this.actualType = actualType;
    }
}

/**
 * Error for invalid field values.
 */
class TaskInvalidValueError extends TaskTryDeserializeError {
    /**
     * @param {string} field
     * @param {unknown} value
     * @param {string} reason
     */
    constructor(field, value, reason) {
        super(`Invalid value for field '${field}': ${reason}`, field, value, "valid");
        this.name = "TaskInvalidValueError";
        this.reason = reason;
    }
}

/**
 * Error for invalid object structure.
 */
class TaskInvalidStructureError extends TaskTryDeserializeError {
    /**
     * @param {string} message
     * @param {unknown} value
     */
    constructor(message, value) {
        super(message, "structure", value, "object");
        this.name = "TaskInvalidStructureError";
    }
}

/**
 * @param {string} field
 * @returns {TaskMissingFieldError}
 */
function makeTaskMissingFieldError(field) {
    return new TaskMissingFieldError(field);
}

/**
 * @param {string} field
 * @param {unknown} value
 * @param {string} expectedType
 * @returns {TaskInvalidTypeError}
 */
function makeTaskInvalidTypeError(field, value, expectedType) {
    return new TaskInvalidTypeError(field, value, expectedType);
}

/**
 * @param {string} field
 * @param {unknown} value
 * @param {string} reason
 * @returns {TaskInvalidValueError}
 */
function makeTaskInvalidValueError(field, value, reason) {
    return new TaskInvalidValueError(field, value, reason);
}

/**
 * @param {string} message
 * @param {unknown} value
 * @returns {TaskInvalidStructureError}
 */
function makeTaskInvalidStructureError(message, value) {
    return new TaskInvalidStructureError(message, value);
}

// Type guard functions
/**
 * @param {unknown} object
 * @returns {object is TaskTryDeserializeError}
 */
function isTaskTryDeserializeError(object) {
    return object instanceof TaskTryDeserializeError;
}

/**
 * @param {unknown} object
 * @returns {object is TaskMissingFieldError}
 */
function isTaskMissingFieldError(object) {
    return object instanceof TaskMissingFieldError;
}

/**
 * @param {unknown} object
 * @returns {object is TaskInvalidTypeError}
 */
function isTaskInvalidTypeError(object) {
    return object instanceof TaskInvalidTypeError;
}

/**
 * @param {unknown} object
 * @returns {object is TaskInvalidValueError}
 */
function isTaskInvalidValueError(object) {
    return object instanceof TaskInvalidValueError;
}

/**
 * @param {unknown} object
 * @returns {object is TaskInvalidStructureError}
 */
function isTaskInvalidStructureError(object) {
    return object instanceof TaskInvalidStructureError;
}

module.exports = {
    makeTaskMissingFieldError,
    makeTaskInvalidTypeError,
    makeTaskInvalidValueError,
    makeTaskInvalidStructureError,
    isTaskTryDeserializeError,
    isTaskMissingFieldError,
    isTaskInvalidTypeError,
    isTaskInvalidValueError,
    isTaskInvalidStructureError,
};
