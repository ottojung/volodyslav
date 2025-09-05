/**
 * Next execution calculation API.
 */

const { fromObject } = require('../../datetime');
const { matchesCronExpression } = require('./current');

const ONE_MINUTE = fromObject({ minutes: 1 });

/**
 * Calculates the next execution time for a cron expression.
 * @param {import('../expression').CronExpression} cronExpr - Parsed cron expression
 * @param {import('../../datetime').DateTime} fromDateTime - DateTime to calculate from
 * @returns {import('../../datetime').DateTime} Next execution datetime
 * @throws {CronCalculationError} If next execution cannot be calculated
 */
function getNextExecution(cronExpr, fromDateTime) {
    let current = fromDateTime.advance(ONE_MINUTE);

    while (!matchesCronExpression(cronExpr, current)) {
        current = current.advance(ONE_MINUTE);
    }

    return current.startOfMinute();
}

module.exports = {
    getNextExecution,
};
