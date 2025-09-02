
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
    
    // For backward compatibility with test mocks, fall back to getTime() comparison
    // if DateTime methods are not available
    if (typeof lastAttemptTime.isAfter !== 'function') {
        // Fallback to millisecond comparison for mock objects or legacy Date objects
        const lastAttemptMs = lastAttemptTime.getTime();
        const lastSuccessMs = task.lastSuccessTime ? task.lastSuccessTime.getTime() : -1;
        const lastFailureMs = task.lastFailureTime ? task.lastFailureTime.getTime() : -1;
        const lastCompletionMs = Math.max(lastSuccessMs, lastFailureMs);
        
        return lastAttemptMs > lastCompletionMs;
    }
    
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
