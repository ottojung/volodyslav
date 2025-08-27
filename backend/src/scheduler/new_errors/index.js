/**
 * Error type guards and exports for the scheduler.
 * This module provides type guard functions for all scheduler error types.
 */

const {
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
} = require('./scheduler_errors');

// === Type Guards ===

/**
 * @param {unknown} object
 * @returns {object is TaskListMismatchError}
 */
function isTaskListMismatchError(object) {
    return object instanceof TaskListMismatchError;
}

/**
 * @param {unknown} object
 * @returns {object is ScheduleTaskError}
 */
function isScheduleTaskError(object) {
    return object instanceof ScheduleTaskError;
}

/**
 * @param {unknown} object
 * @returns {object is StopSchedulerError}
 */
function isStopSchedulerError(object) {
    return object instanceof StopSchedulerError;
}

/**
 * @param {unknown} object
 * @returns {object is InvalidRegistrationError}
 */
function isInvalidRegistrationError(object) {
    return object instanceof InvalidRegistrationError;
}

/**
 * @param {unknown} object
 * @returns {object is RegistrationsNotArrayError}
 */
function isRegistrationsNotArrayError(object) {
    return object instanceof RegistrationsNotArrayError;
}

/**
 * @param {unknown} object
 * @returns {object is RegistrationShapeError}
 */
function isRegistrationShapeError(object) {
    return object instanceof RegistrationShapeError;
}

/**
 * @param {unknown} object
 * @returns {object is CallbackTypeError}
 */
function isCallbackTypeError(object) {
    return object instanceof CallbackTypeError;
}

/**
 * @param {unknown} object
 * @returns {object is RetryDelayTypeError}
 */
function isRetryDelayTypeError(object) {
    return object instanceof RetryDelayTypeError;
}

/**
 * @param {unknown} object
 * @returns {object is NegativeRetryDelayError}
 */
function isNegativeRetryDelayError(object) {
    return object instanceof NegativeRetryDelayError;
}

/**
 * @param {unknown} object
 * @returns {object is InvalidCronExpressionTypeError}
 */
function isInvalidCronExpressionTypeError(object) {
    return object instanceof InvalidCronExpressionTypeError;
}

/**
 * @param {unknown} object
 * @returns {object is CronExpressionInvalidError}
 */
function isCronExpressionInvalidError(object) {
    return object instanceof CronExpressionInvalidError;
}

/**
 * @param {unknown} object
 * @returns {object is InvalidCronExpressionError}
 */
function isInvalidCronExpressionError(object) {
    return object instanceof InvalidCronExpressionError;
}

/**
 * @param {unknown} object
 * @returns {object is FieldParseError}
 */
function isFieldParseError(object) {
    return object instanceof FieldParseError;
}

/**
 * @param {unknown} object
 * @returns {object is CronCalculationError}
 */
function isCronCalculationError(object) {
    return object instanceof CronCalculationError;
}

/**
 * @param {unknown} object
 * @returns {object is ScheduleDuplicateTaskError}
 */
function isScheduleDuplicateTaskError(object) {
    return object instanceof ScheduleDuplicateTaskError;
}

/**
 * @param {unknown} object
 * @returns {object is ScheduleInvalidNameError}
 */
function isScheduleInvalidNameError(object) {
    return object instanceof ScheduleInvalidNameError;
}

/**
 * @param {unknown} object
 * @returns {object is ScheduleFrequencyError}
 */
function isScheduleFrequencyError(object) {
    return object instanceof ScheduleFrequencyError;
}

/**
 * @param {unknown} object
 * @returns {object is TaskNotFoundError}
 */
function isTaskNotFoundError(object) {
    return object instanceof TaskNotFoundError;
}

/**
 * @param {unknown} object
 * @returns {object is TaskAlreadyRegisteredError}
 */
function isTaskAlreadyRegisteredError(object) {
    return object instanceof TaskAlreadyRegisteredError;
}

/**
 * @param {unknown} object
 * @returns {object is TaskNotInRegistrationsError}
 */
function isTaskNotInRegistrationsError(object) {
    return object instanceof TaskNotInRegistrationsError;
}

/**
 * @param {unknown} object
 * @returns {object is TaskTryDeserializeError}
 */
function isTaskTryDeserializeError(object) {
    return object instanceof TaskTryDeserializeError;
}

/**
 * @param {unknown} object
 * @returns {object is TaskMissingFieldError}
 */
function isTaskMissingFieldError(object) {
    return object instanceof TaskMissingFieldError;
}

/**
 * @param {unknown} object
 * @returns {object is TaskInvalidTypeError}
 */
function isTaskInvalidTypeError(object) {
    return object instanceof TaskInvalidTypeError;
}

/**
 * @param {unknown} object
 * @returns {object is TaskInvalidValueError}
 */
function isTaskInvalidValueError(object) {
    return object instanceof TaskInvalidValueError;
}

/**
 * @param {unknown} object
 * @returns {object is TaskInvalidStructureError}
 */
function isTaskInvalidStructureError(object) {
    return object instanceof TaskInvalidStructureError;
}

/**
 * @param {unknown} object
 * @returns {object is DailyTasksUnavailable}
 */
function isDailyTasksUnavailable(object) {
    return object instanceof DailyTasksUnavailable;
}

module.exports = {
    // Error classes
    TaskListMismatchError,
    ScheduleTaskError,
    StopSchedulerError,
    InvalidRegistrationError,
    RegistrationsNotArrayError,
    RegistrationShapeError,
    CallbackTypeError,
    RetryDelayTypeError,
    NegativeRetryDelayError,
    InvalidCronExpressionTypeError,
    CronExpressionInvalidError,
    InvalidCronExpressionError,
    FieldParseError,
    CronCalculationError,
    ScheduleDuplicateTaskError,
    ScheduleInvalidNameError,
    ScheduleFrequencyError,
    TaskNotFoundError,
    TaskAlreadyRegisteredError,
    TaskNotInRegistrationsError,
    TaskTryDeserializeError,
    TaskMissingFieldError,
    TaskInvalidTypeError,
    TaskInvalidValueError,
    TaskInvalidStructureError,
    DailyTasksUnavailable,
    
    // Type guards
    isTaskListMismatchError,
    isScheduleTaskError,
    isStopSchedulerError,
    isInvalidRegistrationError,
    isRegistrationsNotArrayError,
    isRegistrationShapeError,
    isCallbackTypeError,
    isRetryDelayTypeError,
    isNegativeRetryDelayError,
    isInvalidCronExpressionTypeError,
    isCronExpressionInvalidError,
    isInvalidCronExpressionError,
    isFieldParseError,
    isCronCalculationError,
    isScheduleDuplicateTaskError,
    isScheduleInvalidNameError,
    isScheduleFrequencyError,
    isTaskNotFoundError,
    isTaskAlreadyRegisteredError,
    isTaskNotInRegistrationsError,
    isTaskTryDeserializeError,
    isTaskMissingFieldError,
    isTaskInvalidTypeError,
    isTaskInvalidValueError,
    isTaskInvalidStructureError,
    isDailyTasksUnavailable,
};