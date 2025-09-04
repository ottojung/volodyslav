/**
 * Previous fire time calculation API wrapper for mathematical algorithm.
 * Maintains API compatibility with existing code.
 */

const { calculatePreviousExecution } = require("./previous_mathematical");

/**
 * Get the most recent execution time for a cron expression.
 * @param {import('../expression').CronExpression} parsedCron
 * @param {import('../../datetime').DateTime} now
 * @returns {import('../../datetime').DateTime}
 */
function getMostRecentExecution(parsedCron, now) {
    return calculatePreviousExecution(parsedCron, now);
}

module.exports = {
    getMostRecentExecution,
};
