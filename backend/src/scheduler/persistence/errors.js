/**
 * Error types specific to persistence operations.
 */

/**
 * Error thrown when attempting to register a task that is already registered.
 */
class TaskAlreadyRegisteredError extends Error {
    /**
     * @param {string} taskName
     */
    constructor(taskName) {
        super(`Task ${taskName} is already registered`);
        this.name = "TaskAlreadyRegisteredError";
        this.taskName = taskName;
    }
}

module.exports = {
    TaskAlreadyRegisteredError,
};