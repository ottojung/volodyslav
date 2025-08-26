
/**
 * @typedef {import('./structure').Task} Task
 */

/**
 * Check if a task is currently running.
 * @param {Task} task
 * @returns {boolean}
 */
function isRunning(task) {
    return (
        task.lastAttemptTime !== undefined &&
        task.lastSuccessTime === undefined &&
        task.lastFailureTime === undefined
    );
}

module.exports = {
    isRunning,
}
