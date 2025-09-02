
const { toEpochMs } = require("../../datetime");
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
    // Preserve the original timezone
    const originalZone = fromDateTime._luxonDateTime.zone;
    
    const fromMs = toEpochMs(fromDateTime);
    // eslint-disable-next-line volodyslav/no-date-class
    const next = new Date(fromMs); // performance-critical: fast iteration in loop
    next.setSeconds(0, 0); // Reset seconds and milliseconds
    next.setMinutes(next.getMinutes() + 1); // Start from next minute

    // Limit iterations to prevent infinite loops
    const maxIterations = 366 * 24 * 60; // One year worth of minutes
    let iterations = 0;

    while (iterations < maxIterations) {
        // Create DateTime preserving the original timezone
        const nextDateTime = fromLuxon(LuxonDateTime.fromMillis(next.getTime(), { zone: originalZone }));
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
    getNextExecution,
    isCronCalculationError,
};
