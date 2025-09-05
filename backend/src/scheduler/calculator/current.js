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

    // Check minute, hour, and month constraints (these are always AND)
    const basicMatch = (
        isValidInSet(minute, cronExpr.minute) &&
        isValidInSet(hour, cronExpr.hour) &&
        isValidInSet(month, cronExpr.month)
    );

    if (!basicMatch) {
        return false;
    }

    // DOM/DOW OR semantics: when both day and weekday are restricted (not wildcards),
    // the job should run if EITHER the day OR the weekday matches
    const isDayRestricted = !cronExpr.day.every(v => v === true); // Not all days
    const isWeekdayRestricted = !cronExpr.weekday.every(v => v === true); // Not all weekdays

    if (isDayRestricted && isWeekdayRestricted) {
        // Both are restricted - use OR logic
        return isValidInSet(day, cronExpr.day) || isValidInSet(weekday, cronExpr.weekday);
    } else {
        // At least one is wildcard - use AND logic
        return isValidInSet(day, cronExpr.day) && isValidInSet(weekday, cronExpr.weekday);
    }
}

module.exports = {
    matchesCronExpression,
};