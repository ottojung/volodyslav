/**
 * Declarative scheduler module exports.
 * This module provides a static, idempotent scheduler that validates tasks
 * against persisted runtime state.
 */

const { make } = require("./scheduler_factory");
const { isTaskListMismatchError } = require("./errors");

// Re-export types for external consumption
/** @typedef {import('./types').Scheduler} Scheduler */
/** @typedef {import('./types').Registration} Registration */
/** @typedef {import('./types').TaskIdentity} TaskIdentity */
/** @typedef {import('./types').Initialize} Initialize */
/** @typedef {import('./types').Stop} Stop */

module.exports = {
    make,
    isTaskListMismatchError,
};
