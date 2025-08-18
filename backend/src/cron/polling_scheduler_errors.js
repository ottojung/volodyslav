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

/**
 * Error thrown when task frequency is higher than polling frequency.
 */
class ScheduleFrequencyError extends Error {
    /**
     * @param {number} taskFrequencyMs
     * @param {number} pollFrequencyMs
     */
    constructor(taskFrequencyMs, pollFrequencyMs) {
        const taskMinutes = Math.floor(taskFrequencyMs / (60 * 1000));
        const pollMinutes = Math.floor(pollFrequencyMs / (60 * 1000));

        super(
            `Task frequency (${taskMinutes} minute${taskMinutes !== 1 ? 's' : ''}) is higher than ` +
            `polling frequency (${pollMinutes} minute${pollMinutes !== 1 ? 's' : ''}). ` +
            `Tasks cannot execute more frequently than the polling interval.`
        );
        this.name = "ScheduleFrequencyError";
        this.taskFrequencyMs = taskFrequencyMs;
        this.pollFrequencyMs = pollFrequencyMs;
    }
}

/**
 * @param {unknown} object
 * @returns {object is ScheduleFrequencyError}
 */
function isScheduleFrequencyError(object) {
    return object instanceof ScheduleFrequencyError;
}

module.exports = {
    ScheduleDuplicateTaskError,
    isScheduleDuplicateTaskError,
    ScheduleInvalidNameError,
    isScheduleInvalidNameError,
    ScheduleFrequencyError,
    isScheduleFrequencyError,
};

