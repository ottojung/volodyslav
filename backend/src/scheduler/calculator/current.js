/**
 * Cron expression matching using boolean mask lookups.
 */

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
        cronExpr.minute[minute] === true &&
        cronExpr.hour[hour] === true &&
        cronExpr.month[month] === true
    );

    if (!basicMatch) {
        return false;
    }

    // DOM/DOW OR semantics: when both day and weekday are restricted (not wildcards),
    // the job should run if EITHER the day OR the weekday matches
    
    // Check if day field is wildcard (all days 1-31 are true)
    let isDayWildcard = true;
    for (let i = 1; i <= 31; i++) {
        if (!cronExpr.day[i]) {
            isDayWildcard = false;
            break;
        }
    }
    
    // Check if weekday field is wildcard (all weekdays 0-6 are true)
    let isWeekdayWildcard = true;
    for (let i = 0; i <= 6; i++) {
        if (!cronExpr.weekday[i]) {
            isWeekdayWildcard = false;
            break;
        }
    }

    if (!isDayWildcard && !isWeekdayWildcard) {
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