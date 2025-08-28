/**
 * Cron expression matching and calculation utilities.
 */

const datetime = require("../datetime");

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
 * Checks if a given datetime matches the cron expression.
 * @param {import('./expression').CronExpression} cronExpr - Parsed cron expression
 * @param {import('../datetime').DateTime} dateTime - DateTime to check
 * @returns {boolean} True if the datetime matches the cron expression
 */
function matchesCronExpression(cronExpr, dateTime) {
    const dt = datetime.make();
    const nativeDate = dt.toNativeDate(dateTime);

    const minute = nativeDate.getMinutes();
    const hour = nativeDate.getHours();
    const day = nativeDate.getDate();
    const month = nativeDate.getMonth() + 1; // JS months are 0-based, cron months are 1-based
    const weekday = nativeDate.getDay(); // Both JS and cron use 0=Sunday

    return (
        cronExpr.minute.includes(minute) &&
        cronExpr.hour.includes(hour) &&
        cronExpr.day.includes(day) &&
        cronExpr.month.includes(month) &&
        cronExpr.weekday.includes(weekday)
    );
}

/**
 * Calculates the next execution time for a cron expression.
 * @param {import('./expression').CronExpression} cronExpr - Parsed cron expression
 * @param {import('../datetime').DateTime} fromDateTime - DateTime to calculate from
 * @returns {import('../datetime').DateTime} Next execution datetime
 * @throws {CronCalculationError} If next execution cannot be calculated
 */
function getNextExecution(cronExpr, fromDateTime) {
    const dt = datetime.make();
    const fromNative = dt.toNativeDate(fromDateTime);
    const next = new Date(fromNative);
    next.setSeconds(0, 0); // Reset seconds and milliseconds
    next.setMinutes(next.getMinutes() + 1); // Start from next minute

    // Limit iterations to prevent infinite loops
    const maxIterations = 366 * 24 * 60; // One year worth of minutes
    let iterations = 0;

    while (iterations < maxIterations) {
        const nextDateTime = dt.fromEpochMs(next.getTime());
        if (matchesCronExpression(cronExpr, nextDateTime)) {
            return nextDateTime;
        }
        next.setMinutes(next.getMinutes() + 1);
        iterations++;
    }

    throw new CronCalculationError(
        "Could not find next execution time within reasonable timeframe",
        `${cronExpr.minute} ${cronExpr.hour} ${cronExpr.day} ${cronExpr.month} ${cronExpr.weekday}`
    );
}

module.exports = {
    matchesCronExpression,
    getNextExecution,
    isCronCalculationError,
};
