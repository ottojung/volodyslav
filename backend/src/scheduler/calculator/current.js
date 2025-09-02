/**
 * Cron expression matching.
 */

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
    
    // Calculate weekday from Luxon's timezone-aware weekday property
    // Luxon weekday: 1=Monday, 7=Sunday
    // Cron weekday: 0=Sunday, 1=Monday, ..., 6=Saturday
    const luxonWeekday = dateTime.weekday;
    const weekday = luxonWeekday % 7; // Convert: Luxon 7 (Sunday) -> 0, Luxon 1-6 (Mon-Sat) -> 1-6

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
