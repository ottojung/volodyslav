const cron = require('node-cron');

/**
 * @param {string} cronExpression
 * @param {() => Promise<void>} callback
 */
function schedule(cronExpression, callback) {
    cron.schedule(cronExpression, callback);
}

module.exports = {
    schedule,
};
