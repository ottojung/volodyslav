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
    // Extract date components from ISO string instead of using native Date
    const isoString = dateTime.toISOString();
    
    // Parse ISO string: YYYY-MM-DDTHH:mm:ss.sssZ
    const month = parseInt(isoString.slice(5, 7), 10); // Already 1-based like cron
    const day = parseInt(isoString.slice(8, 10), 10);
    const hour = parseInt(isoString.slice(11, 13), 10);
    const minute = parseInt(isoString.slice(14, 16), 10);
    
    // Calculate weekday from epoch milliseconds
    // JavaScript Date.getDay() returns 0=Sunday, which matches cron
    const epochMs = dateTime.getTime();
    const epochDays = Math.floor(epochMs / (24 * 60 * 60 * 1000));
    const weekday = (epochDays + 4) % 7; // January 1, 1970 was a Thursday (4)

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
