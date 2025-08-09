/**
 * @param {import('../capabilities/root').Capabilities} capabilities
 * @param {string} cronExpression
 * @param {() => Promise<void>} callback
 * @param {import('../time_duration/structure').TimeDuration} retryDelay
 * @returns {string} Task ID as string for compatibility
 */
function schedule(capabilities, cronExpression, callback, retryDelay) {
    // Use the scheduler from capabilities instead of creating a new one
    const taskId = capabilities.scheduler.schedule(cronExpression, callback, retryDelay);
    return taskId.toString();
}

module.exports = {
    schedule,
};
