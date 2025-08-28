/**
 * Error classes for registration validation.
 * These errors are defined close to where they are thrown.
 */

/**
 * Error for invalid registration input.
 */
class InvalidRegistrationError extends Error {
    /**
     * @param {string} message
     * @param {object} [details]
     */
    constructor(message, details) {
        super(message);
        this.name = "InvalidRegistrationError";
        this.details = details;
    }
}

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
 * Error for invalid cron expression type.
 */
class InvalidCronExpressionTypeError extends Error {
    /**
     * @param {string} message
     * @param {object} [details]
     */
    constructor(message, details) {
        super(message);
        this.name = "InvalidCronExpressionTypeError";
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
 * Error for invalid callback type.
 */
class CallbackTypeError extends Error {
    /**
     * @param {string} message
     * @param {object} [details]
     */
    constructor(message, details) {
        super(message);
        this.name = "CallbackTypeError";
        this.details = details;
    }
}

/**
 * Error for invalid retry delay type.
 */
class RetryDelayTypeError extends Error {
    /**
     * @param {string} message
     * @param {object} [details]
     */
    constructor(message, details) {
        super(message);
        this.name = "RetryDelayTypeError";
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

module.exports = {
    InvalidRegistrationError,
    RegistrationsNotArrayError,
    RegistrationShapeError,
    InvalidCronExpressionTypeError,
    CronExpressionInvalidError,
    CallbackTypeError,
    RetryDelayTypeError,
    NegativeRetryDelayError,
    ScheduleDuplicateTaskError,
    isScheduleDuplicateTaskError,
    ScheduleInvalidNameError,
};