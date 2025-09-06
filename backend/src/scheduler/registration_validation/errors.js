/**
 * Error classes for registration validation.
 * These errors are defined close to where they are thrown.
 */

/**
 * Error when registrations is not an array.
 */
class RegistrationsNotArrayError extends Error {
    /**
     * @param {string} message
     */
    constructor(message) {
        super(message);
        this.name = "RegistrationsNotArrayError";
    }
}

/**
 * Error for invalid registration shape.
 */
class RegistrationShapeError extends Error {
    /**
     * @param {string} message
     * @param {object} [details]
     */
    constructor(message, details) {
        super(message);
        this.name = "RegistrationShapeError";
        this.details = details;
    }
}

/**
 * Error for invalid cron expression.
 */
class CronExpressionInvalidError extends Error {
    /**
     * @param {string} message
     * @param {object} [details]
     */
    constructor(message, details) {
        super(message);
        this.name = "CronExpressionInvalidError";
        this.details = details;
    }
}

/**
 * Error for negative retry delay.
 */
class NegativeRetryDelayError extends Error {
    /**
     * @param {string} message
     * @param {object} [details]
     */
    constructor(message, details) {
        super(message);
        this.name = "NegativeRetryDelayError";
        this.details = details;
    }
}

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

module.exports = {
    RegistrationsNotArrayError,
    RegistrationShapeError,
    CronExpressionInvalidError,
    NegativeRetryDelayError,
    ScheduleDuplicateTaskError,
    isScheduleDuplicateTaskError,
};
