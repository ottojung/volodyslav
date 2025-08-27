
/**
 * @typedef {import('./structure').Task} Task
 */

/**
 * Check if a task is currently running.
 * @param {Task} task
 * @returns {boolean}
 */
function isRunning(task) {
    if (task.lastAttemptTime === undefined) {
        return false;
    }

    // A task is running if the last attempt is more recent than any completion
    const lastAttemptMs = task.lastAttemptTime.getTime();
    
    const lastSuccessMs = task.lastSuccessTime ? task.lastSuccessTime.getTime() : -1;
    const lastFailureMs = task.lastFailureTime ? task.lastFailureTime.getTime() : -1;
    const lastCompletionMs = Math.max(lastSuccessMs, lastFailureMs);
    
    return lastAttemptMs > lastCompletionMs;
}

module.exports = {
    isRunning,
}
