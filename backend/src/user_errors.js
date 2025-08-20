const { isEnvironmentError } = require("./environment");
const { isServerAddressAlreadyInUseError } = require("./express_app");
const { isNotificationsUnavailable } = require("./notifications");
const { isCommandUnavailable } = require("./subprocess");

/**
 * Error thrown when the task list provided to initialize() differs from persisted runtime state.
 */
class TaskListMismatchError extends Error {
    /**
     * @param {string} message
     * @param {object} mismatchDetails
     * @param {string[]} mismatchDetails.missing - Tasks in persisted state but not in registrations
     * @param {string[]} mismatchDetails.extra - Tasks in registrations but not in persisted state
     * @param {Array<{name: string, field: string, expected: any, actual: any}>} mismatchDetails.differing - Tasks with differing properties
     */
    constructor(message, mismatchDetails) {
        super(message);
        this.name = "TaskListMismatchError";
        this.mismatchDetails = mismatchDetails;
    }
}

/**
 * Error thrown when initialize() is called multiple times.
 */
class MultipleInitializationsError extends Error {
    constructor() {
        super("Scheduler has already been initialized. initialize() calls must be idempotent.");
        this.name = "MultipleInitializationsError";
    }
}

/**
 * @param {unknown} object
 * @returns {object is TaskListMismatchError}
 */
function isTaskListMismatchError(object) {
    return object instanceof TaskListMismatchError;
}

/**
 * @param {unknown} object
 * @returns {object is MultipleInitializationsError}
 */
function isMultipleInitializationsError(object) {
    return object instanceof MultipleInitializationsError;
}

// Export as array for backward compatibility with gentlewrap
const errorCheckers = [
    isEnvironmentError,
    isNotificationsUnavailable,
    isCommandUnavailable,
    isServerAddressAlreadyInUseError,
    isTaskListMismatchError,
    isMultipleInitializationsError,
];

// Export both the array (for compatibility) and individual items
module.exports = errorCheckers;
module.exports.TaskListMismatchError = TaskListMismatchError;
module.exports.MultipleInitializationsError = MultipleInitializationsError;
module.exports.isTaskListMismatchError = isTaskListMismatchError;
module.exports.isMultipleInitializationsError = isMultipleInitializationsError;
