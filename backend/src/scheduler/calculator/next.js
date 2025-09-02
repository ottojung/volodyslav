
const { matchesCronExpression } = require("./current");
const { fromMinutes } = require("../../datetime/duration");

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

/**
 * Calculates the next execution time for a cron expression.
 * @param {import('../expression').CronExpression} cronExpr - Parsed cron expression
 * @param {import('../../datetime').DateTime} fromDateTime - DateTime to calculate from
 * @returns {import('../../datetime').DateTime} Next execution datetime
 * @throws {CronCalculationError} If next execution cannot be calculated
 */
function getNextExecution(cronExpr, fromDateTime) {
    // Start from the next minute with seconds and milliseconds reset
    // Use the timezone-aware method to preserve the original timezone
    let currentDateTime = fromDateTime.startOfNextMinuteForIteration();

    // Limit iterations to prevent infinite loops
    const maxIterations = 366 * 24 * 60; // One year worth of minutes
    let iterations = 0;
    
    // Create one-minute duration for efficient iteration
    const oneMinute = fromMinutes(1);

    while (iterations < maxIterations) {
        if (matchesCronExpression(cronExpr, currentDateTime)) {
            return currentDateTime;
        }
        
        // Use timezone-aware Luxon arithmetic to preserve original timezone
        currentDateTime = currentDateTime.advance(oneMinute);
        iterations++;
    }

    throw new CronCalculationError(
        "Could not find next execution time within reasonable timeframe",
        `${cronExpr.minute} ${cronExpr.hour} ${cronExpr.day} ${cronExpr.month} ${cronExpr.weekday}`
    );
}

module.exports = {
    getNextExecution,
    isCronCalculationError,
};
