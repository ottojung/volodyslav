/**
 * Error classes for polling cron scheduler.
 */

/**
 * Error thrown when attempting to register a task with a name that already exists.
 */
class ScheduleDuplicateTaskError extends Error {
    /**
     * @param {string} taskName
     */
    constructor(taskName) {
        super(`Task with name "${taskName}" is already scheduled`);
        this.name = "ScheduleDuplicateTaskError";
        this.taskName = taskName;
    }
}

/**
 * @param {unknown} object
 * @returns {object is ScheduleDuplicateTaskError}
 */
function isScheduleDuplicateTaskError(object) {
    return object instanceof ScheduleDuplicateTaskError;
}

/**
 * Error thrown when an invalid task name is provided.
 */
class ScheduleInvalidNameError extends Error {
    /**
     * @param {unknown} taskName
     */
    constructor(taskName) {
        super("Task name must be a non-empty string");
        this.name = "ScheduleInvalidNameError";
        this.taskName = /** @type {string} */ (taskName);
    }
}

/**
 * @param {unknown} object
 * @returns {object is ScheduleInvalidNameError}
 */
function isScheduleInvalidNameError(object) {
    return object instanceof ScheduleInvalidNameError;
}

module.exports = {
    ScheduleDuplicateTaskError,
    isScheduleDuplicateTaskError,
    ScheduleInvalidNameError,
    isScheduleInvalidNameError,
};

