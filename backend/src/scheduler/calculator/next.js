
const { matchesCronExpression } = require("./current");
const { fromLuxon } = require("../../datetime/structure");
const { DateTime: LuxonDateTime } = require("luxon");

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
    // Convert directly to Luxon for performance-critical iteration
    const startLuxon = fromDateTime._luxonDateTime
        .set({ second: 0, millisecond: 0 })
        .plus({ minutes: 1 });

    // For better performance, create a native Date for iteration
    // This avoids repeated object creation while still eliminating millisecond conversions
    // eslint-disable-next-line volodyslav/no-date-class
    const iterationDate = startLuxon.toJSDate();

    // Limit iterations to prevent infinite loops
    const maxIterations = 366 * 24 * 60; // One year worth of minutes
    let iterations = 0;

    while (iterations < maxIterations) {
        // Create DateTime wrapper only when needed for matching
        const luxonDt = LuxonDateTime.fromJSDate(iterationDate);
        const currentDateTime = fromLuxon(luxonDt);
        
        if (matchesCronExpression(cronExpr, currentDateTime)) {
            return currentDateTime;
        }
        
        // Use efficient native Date manipulation for iteration
        iterationDate.setMinutes(iterationDate.getMinutes() + 1);
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
