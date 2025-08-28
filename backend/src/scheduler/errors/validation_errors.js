/**
 * Error classes for scheduler validation failures.
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
 * Error thrown when the task list provided to initialize() differs from persisted runtime state.
 */
class TaskListMismatchError extends Error {
    /**
     * @param {string} message
     * @param {object} mismatchDetails
     * @param {string[]} mismatchDetails.missing - Tasks in persisted state but not in registrations
     * @param {string[]} mismatchDetails.extra - Tasks in registrations but not in persisted state
     * @param {Array<{name: string, field: string, expected: any, actual: any}>} mismatchDetails.differing - Tasks with differing properties
     */
    constructor(message, mismatchDetails) {
        super(message);
        this.name = "TaskListMismatchError";
        this.mismatchDetails = mismatchDetails;
    }
}

/**
 * @param {unknown} object
 * @returns {object is TaskListMismatchError}
 */
function isTaskListMismatchError(object) {
    return object instanceof TaskListMismatchError;
}

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
 * @param {unknown} object
 * @returns {object is InvalidRegistrationError}
 */
function isInvalidRegistrationError(object) {
    return object instanceof InvalidRegistrationError;
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
 * @param {unknown} object
 * @returns {object is RegistrationsNotArrayError}
 */
function isRegistrationsNotArrayError(object) {
    return object instanceof RegistrationsNotArrayError;
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
 * @param {unknown} object
 * @returns {object is RegistrationShapeError}
 */
function isRegistrationShapeError(object) {
    return object instanceof RegistrationShapeError;
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
 * @param {unknown} object
 * @returns {object is InvalidCronExpressionTypeError}
 */
function isInvalidCronExpressionTypeError(object) {
    return object instanceof InvalidCronExpressionTypeError;
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
 * @param {unknown} object
 * @returns {object is CronExpressionInvalidError}
 */
function isCronExpressionInvalidError(object) {
    return object instanceof CronExpressionInvalidError;
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
 * @param {unknown} object
 * @returns {object is CallbackTypeError}
 */
function isCallbackTypeError(object) {
    return object instanceof CallbackTypeError;
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
 * @param {unknown} object
 * @returns {object is RetryDelayTypeError}
 */
function isRetryDelayTypeError(object) {
    return object instanceof RetryDelayTypeError;
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
 * @param {unknown} object
 * @returns {object is NegativeRetryDelayError}
 */
function isNegativeRetryDelayError(object) {
    return object instanceof NegativeRetryDelayError;
}

module.exports = {
    ScheduleDuplicateTaskError,
    isScheduleDuplicateTaskError,
    ScheduleInvalidNameError,
    isScheduleInvalidNameError,
    TaskListMismatchError,
    isTaskListMismatchError,
    InvalidRegistrationError,
    isInvalidRegistrationError,
    RegistrationsNotArrayError,
    isRegistrationsNotArrayError,
    RegistrationShapeError,
    isRegistrationShapeError,
    InvalidCronExpressionTypeError,
    isInvalidCronExpressionTypeError,
    CronExpressionInvalidError,
    isCronExpressionInvalidError,
    CallbackTypeError,
    isCallbackTypeError,
    RetryDelayTypeError,
    isRetryDelayTypeError,
    NegativeRetryDelayError,
    isNegativeRetryDelayError,
};