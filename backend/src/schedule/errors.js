/**
 * Error types for the declarative scheduler.
 */

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

/** Additional specific errors used by the scheduler */
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

class RegistrationsNotArrayError extends Error {
    /**
     * @param {string} message
     */
    constructor(message) {
        super(message);
        this.name = "RegistrationsNotArrayError";
    }
}

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

class OptionsTypeError extends Error {
    /**
     * @param {string} message
     */
    constructor(message) {
        super(message);
        this.name = "OptionsTypeError";
    }
}

class InvalidPollIntervalError extends Error {
    /**
     * @param {string} message
     */
    constructor(message) {
        super(message);
        this.name = "InvalidPollIntervalError";
    }
}

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

class PollingFrequencyChangeError extends Error {
    /**
     * @param {number} currentInterval - The currently configured polling interval
     * @param {number} requestedInterval - The requested new polling interval
     */
    constructor(currentInterval, requestedInterval) {
        super(
            `Cannot change polling frequency from ${currentInterval}ms to ${requestedInterval}ms. ` +
            `Polling frequency cannot be changed after scheduler initialization.`
        );
        this.name = "PollingFrequencyChangeError";
        this.currentInterval = currentInterval;
        this.requestedInterval = requestedInterval;
    }
}

// Predicates for all custom error classes
/**
 * @param {unknown} object
 * @returns {object is InvalidRegistrationError}
 */
function isInvalidRegistrationError(object) { return object instanceof InvalidRegistrationError; }
/**
 * @param {unknown} object
 * @returns {object is RegistrationsNotArrayError}
 */
function isRegistrationsNotArrayError(object) { return object instanceof RegistrationsNotArrayError; }
/**
 * @param {unknown} object
 * @returns {object is RegistrationShapeError}
 */
function isRegistrationShapeError(object) { return object instanceof RegistrationShapeError; }
/**
 * @param {unknown} object
 * @returns {object is InvalidCronExpressionTypeError}
 */
function isInvalidCronExpressionTypeError(object) { return object instanceof InvalidCronExpressionTypeError; }
/**
 * @param {unknown} object
 * @returns {object is CronExpressionInvalidError}
 */
function isCronExpressionInvalidError(object) { return object instanceof CronExpressionInvalidError; }
/**
 * @param {unknown} object
 * @returns {object is CallbackTypeError}
 */
function isCallbackTypeError(object) { return object instanceof CallbackTypeError; }
/**
 * @param {unknown} object
 * @returns {object is RetryDelayTypeError}
 */
function isRetryDelayTypeError(object) { return object instanceof RetryDelayTypeError; }
/**
 * @param {unknown} object
 * @returns {object is NegativeRetryDelayError}
 */
function isNegativeRetryDelayError(object) { return object instanceof NegativeRetryDelayError; }
/**
 * @param {unknown} object
 * @returns {object is OptionsTypeError}
 */
function isOptionsTypeError(object) { return object instanceof OptionsTypeError; }
/**
 * @param {unknown} object
 * @returns {object is InvalidPollIntervalError}
 */
function isInvalidPollIntervalError(object) { return object instanceof InvalidPollIntervalError; }
/**
 * @param {unknown} object
 * @returns {object is ScheduleTaskError}
 */
function isScheduleTaskError(object) { return object instanceof ScheduleTaskError; }
/**
 * @param {unknown} object
 * @returns {object is StopSchedulerError}
 */
function isStopSchedulerError(object) { return object instanceof StopSchedulerError; }
/**
 * @param {unknown} object
 * @returns {object is PollingFrequencyChangeError}
 */
function isPollingFrequencyChangeError(object) { return object instanceof PollingFrequencyChangeError; }

module.exports = {
    TaskListMismatchError,
    isTaskListMismatchError,

    InvalidRegistrationError,
    RegistrationsNotArrayError,
    RegistrationShapeError,
    InvalidCronExpressionTypeError,
    CronExpressionInvalidError,
    CallbackTypeError,
    RetryDelayTypeError,
    NegativeRetryDelayError,
    OptionsTypeError,
    InvalidPollIntervalError,
    ScheduleTaskError,
    StopSchedulerError,
    PollingFrequencyChangeError,

    isInvalidRegistrationError,
    isRegistrationsNotArrayError,
    isRegistrationShapeError,
    isInvalidCronExpressionTypeError,
    isCronExpressionInvalidError,
    isCallbackTypeError,
    isRetryDelayTypeError,
    isNegativeRetryDelayError,
    isOptionsTypeError,
    isInvalidPollIntervalError,
    isScheduleTaskError,
    isStopSchedulerError,
    isPollingFrequencyChangeError,
};
