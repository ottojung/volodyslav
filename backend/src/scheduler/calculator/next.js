/**
 * Next execution calculation API wrapper for mathematical algorithm.
 * Maintains API compatibility with existing code.
 */

const { calculateNextExecution, isCronCalculationError } = require("./next_mathematical");

/**
 * Calculates the next execution time for a cron expression.
 * @param {import('../expression').CronExpression} cronExpr - Parsed cron expression
 * @param {import('../../datetime').DateTime} fromDateTime - DateTime to calculate from
 * @returns {import('../../datetime').DateTime} Next execution datetime
 * @throws {CronCalculationError} If next execution cannot be calculated
 */
function getNextExecution(cronExpr, fromDateTime) {
    return calculateNextExecution(cronExpr, fromDateTime);
}

module.exports = {
    getNextExecution,
    isCronCalculationError,
};