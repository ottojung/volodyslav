
const datetime = require("../../datetime");
const { matchesCronExpression } = require("./current");

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
    const dt = datetime.make();
    const fromNative = dt.toNativeDate(fromDateTime);
    
    // Create next minute in milliseconds and convert back to DateTime
    const fromMs = fromNative.getTime();
    const nextMinuteMs = Math.floor(fromMs / (60 * 1000)) * (60 * 1000) + (60 * 1000); // Round up to next minute
    const nextDt = dt.fromEpochMs(nextMinuteMs);

    // Limit iterations to prevent infinite loops
    const maxIterations = 366 * 24 * 60; // One year worth of minutes
    let iterations = 0;

    let currentDt = nextDt;

    while (iterations < maxIterations) {
        if (matchesCronExpression(cronExpr, currentDt)) {
            return currentDt;
        }
        // Add one minute (60,000 milliseconds)
        const nextMs = dt.toEpochMs(currentDt) + (60 * 1000);
        currentDt = dt.fromEpochMs(nextMs);
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
