/**
 * Cron expression matching using boolean mask lookups.
 */

const { weekdayNameToCronNumber } = require("../../datetime");

/**
 * Checks if a given datetime matches the cron expression.
 * @param {import('../expression').CronExpression} cronExpr - Parsed cron expression
 * @param {import('../../datetime').DateTime} dateTime - DateTime to check
 * @returns {boolean} True if the datetime matches the cron expression
 */
function matchesCronExpression(cronExpr, dateTime) {
    // Extract date components
    const month = dateTime.month; // Already 1-based like cron
    const day = dateTime.day;
    const hour = dateTime.hour;
    const minute = dateTime.minute;

    // Check minute, hour, and month constraints (these are always AND)
    const basicMatch = (
        cronExpr.minute[minute] === true &&
        cronExpr.hour[hour] === true &&
        cronExpr.month[month] === true
    );

    if (!basicMatch) {
        return false;
    }

    // Convert weekday name (string) to cron number (1-6) for comparison
    const weekday = weekdayNameToCronNumber(dateTime.weekday);

    // POSIX DOM/DOW semantics: when both day and weekday are restricted (not wildcards),
    // the job should run if EITHER the day OR the weekday matches
    if (cronExpr.isDomDowRestricted) {
        // Both are restricted (not wildcards) - use OR logic
        return cronExpr.day[day] === true || cronExpr.weekday[weekday] === true;
    } else {
        // At least one is wildcard - use AND logic
        return cronExpr.day[day] === true && cronExpr.weekday[weekday] === true;
    }
}

module.exports = {
    matchesCronExpression,
};
