/**
 * Custom error classes for scheduler operations.
 */

/**
 * Custom error class for scheduler operations.
 */
class SchedulerError extends Error {
    /**
     * @param {string} message
     * @param {string} cronExpression
     */
    constructor(message, cronExpression) {
        super(message);
        this.name = "SchedulerError";
        this.cronExpression = cronExpression;
    }
}

/**
 * @param {unknown} object
 * @returns {object is SchedulerError}
 */
function isSchedulerError(object) {
    return object instanceof SchedulerError;
}

/**
 * Custom error class for task not found errors.
 */
class SchedulerTaskNotFoundError extends Error {
    /**
     * @param {string} taskId
     */
    constructor(taskId) {
        super(`Task with ID "${taskId}" not found`);
        this.name = "SchedulerTaskNotFoundError";
        this.taskId = taskId;
    }
}

/**
 * @param {unknown} object
 * @returns {object is SchedulerTaskNotFoundError}
 */
function isSchedulerTaskNotFoundError(object) {
    return object instanceof SchedulerTaskNotFoundError;
}

module.exports = {
    SchedulerError,
    isSchedulerError,
    SchedulerTaskNotFoundError,
    isSchedulerTaskNotFoundError,
};
