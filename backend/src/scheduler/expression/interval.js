/**
 * Cron expression interval calculation functionality.
 * Computes the minimum interval between executions for a cron expression.
 */

const { fromMinutes, fromHours, fromDays } = require("../../datetime");

/** @typedef {import('./structure').CronExpression} CronExpression */

/**
 * Calculate the minimum interval between executions for a cron expression.
 * This helps determine if a task runs more frequently than the polling interval.
 * 
 * @param {CronExpression} cronExpr - The parsed cron expression
 * @returns {import("../../datetime").Duration} The minimum duration between executions
 */
function calculateCronInterval(cronExpr) {
    // Get valid minutes and hours
    const validMinutes = cronExpr.validMinutes;
    const validHours = cronExpr.validHours;
    
    // Check minute-level frequency
    if (validMinutes.length > 1) {
        // Find minimum gap between consecutive minutes
        let minGap = 60; // Maximum possible gap in minutes
        for (let i = 0; i < validMinutes.length; i++) {
            const current = validMinutes[i];
            const next = validMinutes[(i + 1) % validMinutes.length];
            if (current !== undefined && next !== undefined) {
                const gap = next > current ? next - current : (60 - current) + next;
                minGap = Math.min(minGap, gap);
            }
        }
        return fromMinutes(minGap);
    }
    
    // Check hour-level frequency
    if (validHours.length > 1) {
        // Find minimum gap between consecutive hours
        let minGap = 24; // Maximum possible gap in hours
        for (let i = 0; i < validHours.length; i++) {
            const current = validHours[i];
            const next = validHours[(i + 1) % validHours.length];
            if (current !== undefined && next !== undefined) {
                const gap = next > current ? next - current : (24 - current) + next;
                minGap = Math.min(minGap, gap);
            }
        }
        return fromHours(minGap);
    }
    
    // Check if it runs on multiple days/weekdays/months
    // For simplicity, if it has multiple valid days in a month or multiple months,
    // we'll consider it runs at least daily
    const hasMultipleDaysOrWeekdays = cronExpr.day.some((v, i) => v && i > 0) && 
        cronExpr.day.filter(v => v).length > 1;
    const hasMultipleMonths = cronExpr.month.filter(v => v).length > 1;
    
    if (hasMultipleDaysOrWeekdays || hasMultipleMonths) {
        return fromDays(1);
    }
    
    // If only one minute, one hour, and specific day/month constraints,
    // it's likely a daily, weekly, or monthly job - assume daily as minimum
    return fromDays(1);
}

module.exports = {
    calculateCronInterval,
};