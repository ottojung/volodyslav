/**
 * Cron expression matching using mathematical field-based approach.
 */

const { isValidInSet } = require("./field_math");
const { dateTimeWeekdayToCronNumber } = require("./date_helpers");

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
    
    // Convert weekday name (from DateTime) to cron number for comparison
    const weekday = dateTimeWeekdayToCronNumber(dateTime);

    return (
        isValidInSet(minute, cronExpr.minute) &&
        isValidInSet(hour, cronExpr.hour) &&
        isValidInSet(day, cronExpr.day) &&
        isValidInSet(month, cronExpr.month) &&
        isValidInSet(weekday, cronExpr.weekday)
    );
}

module.exports = {
    matchesCronExpression,
};