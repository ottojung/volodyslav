/**
 * Clean scheduler module exports.
 * This module provides a static, idempotent scheduler that validates tasks
 * against persisted runtime state using the new clean architecture.
 */

const { make } = require("./new_scheduler_factory");
const { 
    isTaskListMismatchError,
    ScheduleInvalidNameError,
    ScheduleDuplicateTaskError,
    isScheduleDuplicateTaskError,
    InvalidCronExpressionError,
    isInvalidCronExpressionError,
} = require("./new_errors");

const { 
    parseCronExpression, 
    getNextExecution,
    isCronExpression,
} = require("./new_cron/parser");

/**
 * Validate a cron expression without creating a scheduler.
 * @param {string} cronExpression
 * @returns {boolean}
 */
function validate(cronExpression) {
    try {
        parseCronExpression(cronExpression);
        return true;
    } catch {
        return false;
    }
}

// Re-export types for external consumption
/** @typedef {import('./new_types/scheduler_types').Scheduler} Scheduler */
/** @typedef {import('./new_types/task_types').Registration} Registration */
/** @typedef {import('./new_types/scheduler_types').TaskIdentity} TaskIdentity */
/** @typedef {import('./new_types/scheduler_types').Initialize} Initialize */
/** @typedef {import('./new_types/scheduler_types').Stop} Stop */

module.exports = {
    make,
    validate,
    isTaskListMismatchError,
    ScheduleInvalidNameError,
    ScheduleDuplicateTaskError,
    isScheduleDuplicateTaskError,
    parseCronExpression,
    getNextExecution,
    isCronExpression,
    isInvalidCronExpressionError,
    InvalidCronExpressionError,
};