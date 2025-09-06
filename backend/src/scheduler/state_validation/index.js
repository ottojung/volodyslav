/**
 * State validation module.
 * Encapsulates all functionality related to validating task state against persisted data.
 */

const { validateTasksAgainstPersistedStateInner, analyzeStateChanges } = require("./core");
const { isTaskListMismatchError } = require("./errors");

module.exports = {
    validateTasksAgainstPersistedStateInner,
    analyzeStateChanges,
    isTaskListMismatchError,
};