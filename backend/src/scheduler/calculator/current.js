/**
 * Cron expression matching.
 */

const { weekdayNameToCronNumber } = require("../../datetime");

/**
 * Checks if a given datetime matches the cron expression.
 * @param {import('../expression').CronExpression} cronExpr - Parsed cron expression
 * @param {import('../../datetime').DateTime} dateTime - DateTime to check
 * @returns {boolean} True if the datetime matches the cron expression
 */
function matchesCronExpression(cronExpr, dateTime) {
    // Extract date components using proper DateTime methods instead of string slicing
    const month = dateTime.month; // Already 1-based like cron
    const day = dateTime.day;
    const hour = dateTime.hour;
    const minute = dateTime.minute;
    
    // Convert weekday name (from DateTime) back to cron number for comparison
    const weekdayName = dateTime.weekday; // This is now a string like "monday"
    const weekday = weekdayNameToCronNumber(weekdayName);

    return (
        cronExpr.minute.includes(minute) &&
        cronExpr.hour.includes(hour) &&
        cronExpr.day.includes(day) &&
        cronExpr.month.includes(month) &&
        cronExpr.weekday.includes(weekday)
    );
}

module.exports = {
    matchesCronExpression,
};
