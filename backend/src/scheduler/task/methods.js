
/**
 * @typedef {import('./structure').Task} Task
 */

const { getLastAttemptTime, getLastSuccessTime, getLastFailureTime } = require('./structure');

/**
 * Check if a task is currently running.
 * @param {Task} task
 * @returns {boolean}
 */
function isRunning(task) {
    const lastAttemptTime = getLastAttemptTime(task);
    
    if (lastAttemptTime === undefined || lastAttemptTime === null) {
        return false;
    }

    // A task is running if the last attempt is more recent than any completion
    
    // Find the most recent completion time using DateTime methods
    let lastCompletionTime = undefined;
    
    const lastSuccessTime = getLastSuccessTime(task);
    const lastFailureTime = getLastFailureTime(task);
    
    if (lastSuccessTime && lastFailureTime) {
        // Both exist, find the later one
        lastCompletionTime = lastSuccessTime.isAfter(lastFailureTime) 
            ? lastSuccessTime 
            : lastFailureTime;
    } else if (lastSuccessTime) {
        lastCompletionTime = lastSuccessTime;
    } else if (lastFailureTime) {
        lastCompletionTime = lastFailureTime;
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
