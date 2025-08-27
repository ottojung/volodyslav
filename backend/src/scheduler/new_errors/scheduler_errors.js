/**
 * Consolidated error definitions for the scheduler.
 * This file contains all scheduler-related error classes organized by category.
 */

// === Core Scheduler Errors ===

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
 * Error thrown when scheduler operations fail.
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
 * Error thrown when stopping the scheduler fails.
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

// === Registration Validation Errors ===

/**
 * Error for invalid registration data.
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
 * Error for malformed registration structure.
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

// === Cron Expression Errors ===

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
 * Error for invalid cron expression content.
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
 * Error for invalid cron expressions during parsing.
 */
class InvalidCronExpressionError extends Error {
    /**
     * @param {string} expression
     * @param {string} field
     * @param {string} reason
     */
    constructor(expression, field, reason) {
        super(`Invalid cron expression "${expression}": ${field} field ${reason}`);
        this.name = "InvalidCronExpressionError";
        this.expression = expression;
        this.field = field;
        this.reason = reason;
    }
}

/**
 * Error for field parsing errors in cron expressions.
 */
class FieldParseError extends Error {
    /**
     * @param {string} message
     * @param {string} fieldValue
     * @param {string} fieldName
     */
    constructor(message, fieldValue, fieldName) {
        super(message);
        this.name = "FieldParseError";
        this.fieldValue = fieldValue;
        this.fieldName = fieldName;
    }
}

/**
 * Error for cron calculation failures.
 */
class CronCalculationError extends Error {
    /**
     * @param {string} message
     * @param {object} [details]
     */
    constructor(message, details) {
        super(message);
        this.name = "CronCalculationError";
        this.details = details;
    }
}

// === Task Operation Errors ===

/**
 * Error for duplicate task registration.
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
 * Error for invalid task names.
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
 * Error when task frequency is higher than polling frequency.
 */
class ScheduleFrequencyError extends Error {
    /**
     * @param {string} message
     * @param {object} [details]
     */
    constructor(message, details) {
        super(message);
        this.name = "ScheduleFrequencyError";
        this.details = details;
    }
}

/**
 * Error when task is not found.
 */
class TaskNotFoundError extends Error {
    /**
     * @param {string} taskName
     */
    constructor(taskName) {
        super(`Task "${taskName}" not found`);
        this.name = "TaskNotFoundError";
        this.taskName = taskName;
    }
}

/**
 * Error when task is already registered.
 */
class TaskAlreadyRegisteredError extends Error {
    /**
     * @param {string} taskName
     */
    constructor(taskName) {
        super(`Task "${taskName}" is already registered`);
        this.name = "TaskAlreadyRegisteredError";
        this.taskName = taskName;
    }
}

/**
 * Error when task is not in registrations.
 */
class TaskNotInRegistrationsError extends Error {
    /**
     * @param {string} taskName
     */
    constructor(taskName) {
        super(`Task "${taskName}" not found in registrations`);
        this.name = "TaskNotInRegistrationsError";
        this.taskName = taskName;
    }
}

// === Task Serialization Errors ===

/**
 * Base error for task deserialization failures.
 */
class TaskTryDeserializeError extends Error {
    /**
     * @param {string} message
     * @param {string} field
     * @param {unknown} value
     * @param {string} expectedType
     */
    constructor(message, field, value, expectedType) {
        super(message);
        this.name = "TaskTryDeserializeError";
        this.field = field;
        this.value = value;
        this.expectedType = expectedType;
    }
}

/**
 * Error for missing required fields in task data.
 */
class TaskMissingFieldError extends TaskTryDeserializeError {
    /**
     * @param {string} field
     */
    constructor(field) {
        super(`Missing required field: ${field}`, field, undefined, "any");
        this.name = "TaskMissingFieldError";
    }
}

/**
 * Error for invalid field types in task data.
 */
class TaskInvalidTypeError extends TaskTryDeserializeError {
    /**
     * @param {string} field
     * @param {unknown} value
     * @param {string} expectedType
     */
    constructor(field, value, expectedType) {
        const actualType = Array.isArray(value) ? 'array' : typeof value;
        super(`Invalid type for field '${field}': expected ${expectedType}, got ${actualType}`, 
              field, value, expectedType);
        this.name = "TaskInvalidTypeError";
        this.actualType = actualType;
    }
}

/**
 * Error for invalid field values in task data.
 */
class TaskInvalidValueError extends TaskTryDeserializeError {
    /**
     * @param {string} field
     * @param {unknown} value
     * @param {string} reason
     */
    constructor(field, value, reason) {
        super(`Invalid value for field '${field}': ${reason}`, field, value, "valid value");
        this.name = "TaskInvalidValueError";
        this.reason = reason;
    }
}

/**
 * Error for invalid task data structure.
 */
class TaskInvalidStructureError extends TaskTryDeserializeError {
    /**
     * @param {string} message
     * @param {unknown} value
     */
    constructor(message, value) {
        super(message, "structure", value, "object");
        this.name = "TaskInvalidStructureError";
    }
}

// === Daily Tasks Errors ===

/**
 * Error when daily tasks are unavailable.
 */
class DailyTasksUnavailable extends Error {
    /**
     * @param {string} message
     */
    constructor(message) {
        super(message);
        this.name = "DailyTasksUnavailable";
    }
}

module.exports = {
    // Core Scheduler Errors
    TaskListMismatchError,
    ScheduleTaskError,
    StopSchedulerError,
    
    // Registration Validation Errors
    InvalidRegistrationError,
    RegistrationsNotArrayError,
    RegistrationShapeError,
    CallbackTypeError,
    RetryDelayTypeError,
    NegativeRetryDelayError,
    
    // Cron Expression Errors
    InvalidCronExpressionTypeError,
    CronExpressionInvalidError,
    InvalidCronExpressionError,
    FieldParseError,
    CronCalculationError,
    
    // Task Operation Errors
    ScheduleDuplicateTaskError,
    ScheduleInvalidNameError,
    ScheduleFrequencyError,
    TaskNotFoundError,
    TaskAlreadyRegisteredError,
    TaskNotInRegistrationsError,
    
    // Task Serialization Errors
    TaskTryDeserializeError,
    TaskMissingFieldError,
    TaskInvalidTypeError,
    TaskInvalidValueError,
    TaskInvalidStructureError,
    
    // Daily Tasks Errors
    DailyTasksUnavailable,
};