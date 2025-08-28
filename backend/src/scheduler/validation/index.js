/**
 * Validation logic for scheduler registrations and task state.
 * This module provides a single point of access for all validation functions.
 */

// Import validation functions
const { validateTasksAgainstPersistedStateInner } = require('./state_validation');
const { validateRegistrations } = require('./registration_validation');

// Import error type guards for convenience
const { isTaskListMismatchError, isScheduleDuplicateTaskError } = require('../errors');

module.exports = {
    validateTasksAgainstPersistedStateInner,
    validateRegistrations,
    isTaskListMismatchError,
    isScheduleDuplicateTaskError,
};