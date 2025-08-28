/**
 * Declarative scheduler module exports.
 * This module provides a static, idempotent scheduler that validates tasks
 * against persisted runtime state.
 * 
 * The scheduler uses a purely declarative interface - no procedural APIs
 * like start, stop, schedule, or cancel are exposed to external consumers.
 */

const { make } = require("./scheduler_factory");
const { isScheduleDuplicateTaskError } = require("./registration_validation");
const { isTaskListMismatchError } = require("./state_validation");
const {
    parseCronExpression,
    isCronExpression,
    isInvalidCronExpressionError
} = require('./expression')
const { matchesCronExpression, getNextExecution } = require("./calculator/current");

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
/** @typedef {import('./types').Scheduler} Scheduler */
/** @typedef {import('./types').Registration} Registration */
/** @typedef {import('./types').TaskIdentity} TaskIdentity */
/** @typedef {import('./types').Initialize} Initialize */
/** @typedef {import('./types').Stop} Stop */

module.exports = {
    make,
    validate,
    isTaskListMismatchError,
    isScheduleDuplicateTaskError,
    parseCronExpression,
    matchesCronExpression,
    getNextExecution,
    isCronExpression,
    isInvalidCronExpressionError,
};
