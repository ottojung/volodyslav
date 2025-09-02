
/**
 * @typedef {import('./structure').Task} Task
 */

/**
 * Check if a task is currently running.
 * @param {Task} task
 * @returns {boolean}
 */
function isRunning(task) {
    if (task.lastAttemptTime === undefined || task.lastAttemptTime === null) {
        return false;
    }

    // A task is running if the last attempt is more recent than any completion
    const lastAttemptTime = task.lastAttemptTime;
    
    // Find the most recent completion time using DateTime methods
    let lastCompletionTime = undefined;
    
    if (task.lastSuccessTime && task.lastFailureTime) {
        // Both exist, find the later one
        lastCompletionTime = task.lastSuccessTime.isAfter(task.lastFailureTime) 
            ? task.lastSuccessTime 
            : task.lastFailureTime;
    } else if (task.lastSuccessTime) {
        lastCompletionTime = task.lastSuccessTime;
    } else if (task.lastFailureTime) {
        lastCompletionTime = task.lastFailureTime;
    }
    
    // If no completion time, task is running since last attempt
    if (!lastCompletionTime) {
        return true;
    }
    
    return lastAttemptTime.isAfter(lastCompletionTime);
}

module.exports = {
    isRunning,
};
