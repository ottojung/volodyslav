/**
 * Calculate the minimum interval between executions for a cron expression.
 */

const { fromMinutes } = require("../../datetime/duration");

/**
 * Calculate the minimum possible interval between consecutive executions
 * of a cron expression by analyzing its field constraints.
 * 
 * @param {import('../types').CronExpression} cronExpr
 * @returns {import('../../datetime').Duration} The minimum interval duration
 */
function getMinimumCronInterval(cronExpr) {
    // Get the valid values from the cron expression
    const minuteValues = cronExpr.validMinutes;
    const hourValues = cronExpr.validHours;
    // Note: We don't have direct getters for day, month, weekday values
    // but we can calculate based on minute/hour constraints for most cases
    
    // If minute field has multiple values, the minimum interval is the 
    // smallest gap between consecutive minutes
    if (minuteValues.length > 1) {
        const sortedMinutes = [...minuteValues].sort((a, b) => a - b);
        let minGap = 60; // Default to 60 minutes if only one occurrence per hour
        
        for (let i = 1; i < sortedMinutes.length; i++) {
            const prevMinute = sortedMinutes[i - 1];
            const currMinute = sortedMinutes[i];
            if (prevMinute !== undefined && currMinute !== undefined) {
                const gap = currMinute - prevMinute;
                if (gap < minGap) {
                    minGap = gap;
                }
            }
        }
        
        // Also check the wrap-around gap (from last to first minute of next hour)
        const lastMinute = sortedMinutes[sortedMinutes.length - 1];
        const firstMinute = sortedMinutes[0];
        if (lastMinute !== undefined && firstMinute !== undefined) {
            const wrapGap = (60 - lastMinute) + firstMinute;
            if (wrapGap < minGap) {
                minGap = wrapGap;
            }
        }
        
        return fromMinutes(minGap);
    }
    
    // If only one minute value but multiple hours, minimum interval is 1 hour
    if (hourValues.length > 1) {
        return fromMinutes(60);
    }
    
    // For more complex cases involving days/months/weekdays, we need more analysis
    // For now, use heuristics based on common patterns:
    
    // If we reach here, it's likely a daily, weekly, monthly or yearly pattern
    // For simplicity, assume it's at least daily
    return fromMinutes(24 * 60);
}

module.exports = {
    getMinimumCronInterval,
};