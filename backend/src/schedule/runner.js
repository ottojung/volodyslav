const { make } = require('../cron');

// Create a shared cron scheduler instance
const cronScheduler = make();

/**
 * @param {string} cronExpression
 * @param {() => Promise<void>} callback
 * @returns {string} Task ID as string for compatibility
 */
function schedule(cronExpression, callback) {
    const taskId = cronScheduler.schedule(cronExpression, callback);
    return taskId.toString();
}

module.exports = {
    schedule,
};
