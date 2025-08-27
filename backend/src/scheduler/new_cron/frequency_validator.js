/**
 * Cron expression frequency validation.
 * Validates that cron expressions don't fire too frequently relative to polling interval.
 */

const { ScheduleFrequencyError } = require('../new_errors');
const { parseCronExpression } = require('./parser');

/**
 * Calculate the minimum theoretical interval between cron fires.
 * @param {import('./parser').CronExpression} cronExpr - Parsed cron expression
 * @returns {number} Minimum interval in milliseconds
 */
function calculateMinimumCronInterval(cronExpr) {
    // For cron expressions, the minimum interval is typically 1 minute (60000ms)
    // unless it's a very specific pattern that could fire more frequently
    
    // Check if all time fields allow multiple values
    const hasMultipleMinutes = cronExpr.minute.length > 1;
    const hasMultipleHours = cronExpr.hour.length > 1;
    const hasMultipleDays = cronExpr.day.length > 1;
    const hasMultipleMonths = cronExpr.month.length > 1;
    const hasMultipleWeekdays = cronExpr.weekday.length > 1;

    // If minutes field has multiple values, find the smallest gap
    if (hasMultipleMinutes) {
        let minGap = 60; // Maximum possible gap in minutes
        const sortedMinutes = cronExpr.minute.sort((a, b) => a - b);
        
        for (let i = 1; i < sortedMinutes.length; i++) {
            const gap = sortedMinutes[i] - sortedMinutes[i - 1];
            minGap = Math.min(minGap, gap);
        }
        
        // Also check wrap-around gap (e.g., from 59 to 0)
        if (sortedMinutes.length > 1) {
            const wrapGap = (60 - sortedMinutes[sortedMinutes.length - 1]) + sortedMinutes[0];
            minGap = Math.min(minGap, wrapGap);
        }
        
        return minGap * 60000; // Convert to milliseconds
    }

    // If only one minute specified, check hour intervals
    if (hasMultipleHours) {
        return 60 * 60000; // 1 hour minimum
    }

    // If daily or less frequent, minimum is 24 hours
    if (hasMultipleDays || hasMultipleWeekdays || hasMultipleMonths) {
        return 24 * 60 * 60000; // 24 hours
    }

    // Single minute, hour, day - minimum is based on the least specific field
    if (cronExpr.month.length === 12) {
        return 60000; // Every minute
    } else if (cronExpr.day.length === 31 && cronExpr.weekday.length === 7) {
        return 60000; // Every minute  
    } else if (cronExpr.hour.length === 24) {
        return 60000; // Every minute
    } else {
        return 24 * 60 * 60000; // Daily
    }
}

/**
 * Validate that a task's frequency is compatible with the polling interval.
 * @param {string} taskName - Name of the task
 * @param {string} cronExpression - Cron expression string
 * @param {number} pollingIntervalMs - Polling interval in milliseconds
 * @throws {ScheduleFrequencyError} If frequency is too high
 */
function validateTaskFrequency(taskName, cronExpression, pollingIntervalMs) {
    try {
        const parsedCron = parseCronExpression(cronExpression);
        const minInterval = calculateMinimumCronInterval(parsedCron);
        
        // Frequency is too high if minimum interval is less than polling interval
        if (minInterval < pollingIntervalMs) {
            throw new ScheduleFrequencyError(
                `Task "${taskName}" has a cron expression "${cronExpression}" that could fire every ${minInterval}ms, ` +
                `which is faster than the polling interval of ${pollingIntervalMs}ms. ` +
                `This makes the task unobservable by the scheduler.`,
                {
                    taskName,
                    cronExpression,
                    minIntervalMs: minInterval,
                    pollingIntervalMs,
                }
            );
        }
    } catch (err) {
        if (err instanceof ScheduleFrequencyError) {
            throw err;
        }
        // Re-throw parsing errors as frequency errors for consistency
        throw new ScheduleFrequencyError(
            `Cannot validate frequency for task "${taskName}": ${err instanceof Error ? err.message : String(err)}`,
            {
                taskName,
                cronExpression,
                cause: err,
            }
        );
    }
}

module.exports = {
    calculateMinimumCronInterval,
    validateTaskFrequency,
};