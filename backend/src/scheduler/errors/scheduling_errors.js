/**
 * Error classes for scheduler operational failures.
 */

/**
 * Error thrown when a task is not found in the runtime task map.
 */
class TaskNotFoundError extends Error {
    /**
     * @param {string} taskName
     */
    constructor(taskName) {
        super(`Task ${JSON.stringify(taskName)} not found`);
        this.name = "TaskNotFoundError";
        this.taskName = taskName;
    }
}

/**
 * @param {unknown} object
 * @returns {object is TaskNotFoundError}
 */
function isTaskNotFoundError(object) {
    return object instanceof TaskNotFoundError;
}

/**
 * Error for task scheduling failures.
 */
class ScheduleTaskError extends Error {
    /**
     * @param {string} message
     * @param {object} [details]
     */
    constructor(message, details) {
        super(message);
        this.name = "ScheduleTaskError";
        this.details = details;
    }
}

/**
 * @param {unknown} object
 * @returns {object is ScheduleTaskError}
 */
function isScheduleTaskError(object) {
    return object instanceof ScheduleTaskError;
}

/**
 * Error for scheduler stop failures.
 */
class StopSchedulerError extends Error {
    /**
     * @param {string} message
     * @param {object} [details]
     */
    constructor(message, details) {
        super(message);
        this.name = "StopSchedulerError";
        this.details = details;
    }
}

/**
 * @param {unknown} object
 * @returns {object is StopSchedulerError}
 */
function isStopSchedulerError(object) {
    return object instanceof StopSchedulerError;
}

module.exports = {
    TaskNotFoundError,
    isTaskNotFoundError,
    ScheduleTaskError,
    isScheduleTaskError,
    StopSchedulerError,
    isStopSchedulerError,
};