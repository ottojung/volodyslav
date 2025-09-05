/**
 * Cron expression matching using boolean mask lookups.
 */

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

    return cronExpr.isValidDay(day, dateTime.weekday);
}

module.exports = {
    matchesCronExpression,
};
