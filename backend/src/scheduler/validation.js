/**
 * Validation logic for scheduler registrations and task state.
 * This module now serves as a facade to the encapsulated validation modules.
 */

const { validateRegistrations, isScheduleDuplicateTaskError } = require("./registration_validation");
const { validateTasksAgainstPersistedStateInner, isTaskListMismatchError } = require("./state_validation");

module.exports = {
    validateTasksAgainstPersistedStateInner,
    validateRegistrations,
    isTaskListMismatchError,
    isScheduleDuplicateTaskError,
};