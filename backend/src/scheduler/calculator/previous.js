/**
 * Previous fire time calculation API.
 */

const { matchesCronExpression } = require("./current");
const { fromObject } = require("../../datetime");

const ONE_MINUTE = fromObject({ minutes: 1 });

/**
 * Calculates the previous execution time for a cron expression.
 * Edge case: if fromDateTime is exactly 0 seconds of a matching minute, it will return the previous match.
 * @param {import('../expression').CronExpression} cronExpr - Parsed cron expression
 * @param {import('../../datetime').DateTime} fromDateTime - DateTime to calculate from
 * @returns {import('../../datetime').DateTime} Previous execution datetime, or null if none found
 */
function getMostRecentExecution(cronExpr, fromDateTime) {
    let current = fromDateTime.startOfMinute();
    if (current.equals(fromDateTime)) {
        // If fromDateTime is exactly at the start of a matching minute, move back one minute
        current = current.subtract(ONE_MINUTE);
    }

    while (!matchesCronExpression(cronExpr, current)) {
        current = current.subtract(ONE_MINUTE);
    }

    return current.startOfMinute();
}

module.exports = {
    getMostRecentExecution,
};
