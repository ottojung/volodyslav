/**
 * Previous fire time calculation API.
 */

const { matchesCronExpression } = require("./current");
const { fromObject } = require("../../datetime");

/**
 * Custom error class for calculation errors.
 */
class CronCalculationError extends Error {
    /**
     * @param {string} message
     * @param {string} cronExpression
     */
    constructor(message, cronExpression) {
        super(message);
        this.name = "CronCalculationError";
        this.cronExpression = cronExpression;
    }
}

/**
 * @param {unknown} object
 * @returns {object is CronCalculationError}
 */
function isCronCalculationError(object) {
    return object instanceof CronCalculationError;
}

const ONE_MINUTE = fromObject({ minutes: 1 });

/**
 * Calculates the previous execution time for a cron expression.
 * @param {import('../expression').CronExpression} cronExpr - Parsed cron expression
 * @param {import('../../datetime').DateTime} fromDateTime - DateTime to calculate from
 * @returns {import('../../datetime').DateTime} Previous execution datetime, or null if none found
 */
function getMostRecentExecution(cronExpr, fromDateTime) {
    let current = fromDateTime.subtract(ONE_MINUTE);

    while (!matchesCronExpression(cronExpr, current)) {
        current = current.subtract(ONE_MINUTE);
    }

    return current;
}

module.exports = {
    getMostRecentExecution,
    isCronCalculationError,
};
