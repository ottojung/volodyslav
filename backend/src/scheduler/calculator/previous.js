/**
 * Previous fire time calculation API.
 */

const { matchesCronExpression } = require("./current");
const { fromObject } = require("../../datetime");

const ONE_MINUTE = fromObject({ minutes: 1 });

/**
 * Calculates the previous execution time for a cron expression.
 * Edge case: if fromDateTime is exactly 0 seconds of a matching minute, it will return current match.
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
