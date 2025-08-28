/**
 * Consolidated error classes for the scheduler module.
 * This module provides a single point of access for all scheduler-related errors.
 */

// Import validation errors
const {
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
} = require('./validation_errors');

// Import scheduling errors
const {
    TaskNotFoundError,
    isTaskNotFoundError,
    ScheduleTaskError,
    isScheduleTaskError,
    StopSchedulerError,
    isStopSchedulerError,
} = require('./scheduling_errors');

module.exports = {
    // Validation errors
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
    
    // Scheduling errors
    TaskNotFoundError,
    isTaskNotFoundError,
    ScheduleTaskError,
    isScheduleTaskError,
    StopSchedulerError,
    isStopSchedulerError,
};