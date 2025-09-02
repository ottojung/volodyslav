
const { matchesCronExpression } = require("./current");
const { fromLuxon } = require("../../datetime/structure");
const { Duration } = require("luxon");

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

// Pre-create the one-minute duration for performance
const ONE_MINUTE_DURATION = Duration.fromObject({ minutes: 1 });

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
    const startDateTime = fromDateTime.startOfNextMinuteForIteration();

    // Extract the Luxon DateTime to use efficient Luxon arithmetic while preserving timezone
    let currentLuxonDateTime = startDateTime._luxonDateTime;

    // Limit iterations to prevent infinite loops
    const maxIterations = 366 * 24 * 60; // One year worth of minutes
    let iterations = 0;

    while (iterations < maxIterations) {
        // Create DateTime wrapper only when needed for matching
        const currentDateTime = fromLuxon(currentLuxonDateTime);
        
        if (matchesCronExpression(cronExpr, currentDateTime)) {
            return currentDateTime;
        }
        
        // Use efficient Luxon arithmetic while preserving original timezone
        currentLuxonDateTime = currentLuxonDateTime.plus(ONE_MINUTE_DURATION);
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
