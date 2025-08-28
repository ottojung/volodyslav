/**
 * State validation module.
 * Encapsulates all functionality related to validating task state against persisted data.
 */

const { validateTasksAgainstPersistedStateInner } = require("./core");
const { isTaskListMismatchError } = require("./errors");

module.exports = {
    validateTasksAgainstPersistedStateInner,
    isTaskListMismatchError,
};