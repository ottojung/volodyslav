/**
 * Task ID nominal type for type safety.
 */

/**
 * Nominal type for task IDs to prevent mixing with regular strings.
 */
class TaskIdClass {
    /** @type {undefined} */
    __brand = undefined; // nominal typing brand

    /**
     * @param {string} value
     */
    constructor(value) {
        if (this.__brand !== undefined) {
            throw new Error("TaskId is a nominal type");
        }
        this.value = value;
    }

    /**
     * @returns {string}
     */
    toString() {
        return this.value;
    }
}

/**
 * @param {unknown} object
 * @returns {object is TaskIdClass}
 */
function isTaskId(object) {
    return object instanceof TaskIdClass;
}

/**
 * Factory function to create a new task ID.
 * @param {string} value - The task ID value
 * @returns {TaskIdClass}
 */
function makeTaskId(value) {
    return new TaskIdClass(value);
}

/**
 * Generates a unique task ID.
 * @param {number} counter - Counter value for uniqueness
 * @returns {TaskIdClass}
 */
function generateTaskId(counter) {
    return makeTaskId(`task_${counter}`);
}

module.exports = {
    TaskIdClass,
    isTaskId,
    makeTaskId,
    generateTaskId,
};
