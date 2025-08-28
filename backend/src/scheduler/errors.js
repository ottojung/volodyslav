// @ts-check
/**
 * Error classes for the scheduler.
 */

/**
 * Startup drift error when persisted state doesn't match registrations.
 */
class StartupDriftError extends Error {
    /**
     * @param {string} message
     * @param {object} details
     */
    constructor(message, details) {
        super(message);
        this.name = "StartupDriftError";
        this.details = details;
        this.mismatchDetails = details; // Alias for backward compatibility
    }
}

/**
 * Duplicate task error when multiple tasks have the same identifier.
 */
class DuplicateTaskError extends Error {
    /**
     * @param {string} taskName
     */
    constructor(taskName) {
        super(`Duplicate task: ${taskName}`);
        this.name = "DuplicateTaskError";
        this.taskName = taskName;
    }
}

/**
 * Duplicate task error for scheduler API compatibility.
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
 * Invalid task name error for scheduler API compatibility.
 */
class ScheduleInvalidNameError extends Error {
    /**
     * @param {string} taskName
     */
    constructor(taskName) {
        super(`Invalid task name: "${taskName}"`);
        this.name = "ScheduleInvalidNameError";
        this.taskName = taskName;
    }
}

/**
 * Invalid cron expression error.
 */
class InvalidCronError extends Error {
    /**
     * @param {string} expression
     * @param {string} reason
     */
    constructor(expression, reason) {
        super(`Invalid cron expression "${expression}": ${reason}`);
        this.name = "InvalidCronError";
        this.expression = expression;
        this.reason = reason;
    }
}

/**
 * Frequency guard error when cron frequency exceeds poll interval.
 */
class FrequencyGuardError extends Error {
    /**
     * @param {string} taskName
     * @param {number} cronIntervalMs
     * @param {number} pollIntervalMs
     */
    constructor(taskName, cronIntervalMs, pollIntervalMs) {
        super(`Task "${taskName}" has cron frequency (${cronIntervalMs}ms) faster than poll interval (${pollIntervalMs}ms)`);
        this.name = "FrequencyGuardError";
        this.taskName = taskName;
        this.cronIntervalMs = cronIntervalMs;
        this.pollIntervalMs = pollIntervalMs;
    }
}

/**
 * State persistence error.
 */
class StatePersistenceError extends Error {
    /**
     * @param {string} operation
     * @param {Error} cause
     */
    constructor(operation, cause) {
        super(`State persistence error during ${operation}: ${cause.message}`);
        this.name = "StatePersistenceError";
        this.operation = operation;
        this.cause = cause;
    }
}

/**
 * Task execution error.
 */
class TaskExecutionError extends Error {
    /**
     * @param {string} taskName
     * @param {Error} cause
     */
    constructor(taskName, cause) {
        super(`Task execution error for "${taskName}": ${cause.message}`);
        this.name = "TaskExecutionError";
        this.taskName = taskName;
        this.cause = cause;
    }
}

/**
 * Type guard for StartupDriftError.
 * @param {any} object
 * @returns {object is StartupDriftError}
 */
function isStartupDriftError(object) {
    return object instanceof StartupDriftError;
}

/**
 * Type guard for DuplicateTaskError.
 * @param {any} object
 * @returns {object is DuplicateTaskError}
 */
function isDuplicateTaskError(object) {
    return object instanceof DuplicateTaskError;
}

/**
 * Type guard for ScheduleDuplicateTaskError.
 * @param {any} object
 * @returns {object is ScheduleDuplicateTaskError}
 */
function isScheduleDuplicateTaskError(object) {
    return object instanceof ScheduleDuplicateTaskError;
}

/**
 * Type guard for ScheduleInvalidNameError.
 * @param {any} object
 * @returns {object is ScheduleInvalidNameError}
 */
function isScheduleInvalidNameError(object) {
    return object instanceof ScheduleInvalidNameError;
}

/**
 * Type guard for InvalidCronError.
 * @param {any} object
 * @returns {object is InvalidCronError}
 */
function isInvalidCronError(object) {
    return object instanceof InvalidCronError;
}

/**
 * Type guard for FrequencyGuardError.
 * @param {any} object
 * @returns {object is FrequencyGuardError}
 */
function isFrequencyGuardError(object) {
    return object instanceof FrequencyGuardError;
}

/**
 * Type guard for StatePersistenceError.
 * @param {any} object
 * @returns {object is StatePersistenceError}
 */
function isStatePersistenceError(object) {
    return object instanceof StatePersistenceError;
}

/**
 * Type guard for TaskExecutionError.
 * @param {any} object
 * @returns {object is TaskExecutionError}
 */
function isTaskExecutionError(object) {
    return object instanceof TaskExecutionError;
}

module.exports = {
    StartupDriftError,
    DuplicateTaskError,
    ScheduleDuplicateTaskError,
    ScheduleInvalidNameError,
    InvalidCronError,
    FrequencyGuardError,
    StatePersistenceError,
    TaskExecutionError,
    isStartupDriftError,
    isDuplicateTaskError,
    isScheduleDuplicateTaskError,
    isScheduleInvalidNameError,
    isInvalidCronError,
    isFrequencyGuardError,
    isStatePersistenceError,
    isTaskExecutionError,
};