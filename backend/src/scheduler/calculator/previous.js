/**
 * Previous fire time calculation API.
 */

const { matchesCronExpression } = require("./current");
const { fromObject } = require("../../datetime");

const ONE_MINUTE = fromObject({ minutes: 1 });

/**
 * Calculates the previous execution time for a cron expression.
 * Note: it is inclusive. I.e. if `fromDateTime` matches the cron expression,
 * it will be returned as the previous execution time.
 * @param {import('../expression').CronExpression} cronExpr - Parsed cron expression
 * @param {import('../../datetime').DateTime} fromDateTime - DateTime to calculate from
 * @returns {import('../../datetime').DateTime} Previous execution datetime, or null if none found
 */
function getMostRecentExecution(cronExpr, fromDateTime) {
    let current = fromDateTime.startOfMinute();

    while (!matchesCronExpression(cronExpr, current)) {
        current = current.subtract(ONE_MINUTE);
    }

    return current;
}

module.exports = {
    getMostRecentExecution,
};
