/**
 * Declarative scheduler module exports.
 * This module provides a static, idempotent scheduler that validates tasks
 * against persisted runtime state.
 * 
 * The scheduler uses a purely declarative interface - no procedural APIs
 * like start, stop, schedule, or cancel are exposed to external consumers.
 */

const { make } = require("./make");
const { isScheduleDuplicateTaskError, isSchedulerAlreadyActiveError } = require("./registration_validation");
const { isCronExpression, isInvalidCronExpressionError } = require('./expression')

// Re-export types for external consumption
/** @typedef {import('./types').Scheduler} Scheduler */
/** @typedef {import('./types').Registration} Registration */
/** @typedef {import('./types').TaskIdentity} TaskIdentity */
/** @typedef {import('./types').Initialize} Initialize */
/** @typedef {import('./types').Stop} Stop */

module.exports = {
    make,
    isScheduleDuplicateTaskError,
    isSchedulerAlreadyActiveError,
    isCronExpression,
    isInvalidCronExpressionError,
};
