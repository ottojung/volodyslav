// @ts-check
/**
 * @typedef {string & {__brand:'TaskId'}} TaskId
 */

/**
 * Task identifier (nominal type).
 */
class TaskIdClass {
    /** @type {string} */
    value;

    /** @type {undefined} */
    __brand = undefined; // nominal typing brand

    /**
     * Creates a new TaskId instance.
     * @param {string} value - Task identifier string
     */
    constructor(value) {
        if (this.__brand !== undefined) {
            throw new Error("TaskId is a nominal type");
        }

        if (typeof value !== 'string' || value.length === 0) {
            throw new Error("TaskId must be a non-empty string");
        }

        // Validate safe characters (alphanumeric, dash, underscore)
        if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
            throw new Error("TaskId must contain only alphanumeric characters, dashes, and underscores");
        }

        this.value = value;
    }

    /**
     * Get the string value.
     * @returns {string}
     */
    toString() {
        return this.value;
    }
}

/**
 * Create a TaskId from a string.
 * @param {string} s - Task identifier string
 * @returns {TaskId}
 */
function fromString(s) {
    return /** @type {TaskId} */ (new TaskIdClass(s));
}

/**
 * Convert TaskId to string.
 * @param {TaskId} id - Task identifier
 * @returns {string}
 */
function toString(id) {
    return id.value;
}

/**
 * Type guard for TaskId.
 * @param {any} object
 * @returns {object is TaskId}
 */
function isTaskId(object) {
    return object instanceof TaskIdClass;
}

module.exports = {
    fromString,
    toString,
    isTaskId,
};