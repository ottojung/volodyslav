/**
 * Mathematical previous execution algorithm for cron expressions.
 * Implements O(1) field-based calculation instead of iteration.
 */

const { 
    prevInSetWithUnderflow, 
    maxInSet, 
    isValidInSet 
} = require("./field_math");

const { 
    validDaysInMonth, 
    prevDateSatisfyingWeekdayConstraint,
    getWeekday
} = require("./date_helpers");

const { fromLuxon } = require("../../datetime/structure");

/**
 * Custom error class for calculation errors.
 */
class CronCalculationError extends Error {
    /**
     * @param {string} message
     * @param {string} cronExpression
     */
    constructor(message, cronExpression) {
        super(message);
        this.name = "CronCalculationError";
        this.cronExpression = cronExpression;
    }
}

/**
 * @param {unknown} object
 * @returns {object is CronCalculationError}
 */
function isCronCalculationError(object) {
    return object instanceof CronCalculationError;
}

/**
 * Calculates the previous execution time for a cron expression using mathematical field calculation.
 * @param {import('../expression').CronExpression} cronExpr - Parsed cron expression
 * @param {import('../../datetime').DateTime} fromDateTime - DateTime to calculate from
 * @returns {import('../../datetime').DateTime|null} Previous execution datetime, or null if none found
 */
function calculatePreviousExecution(cronExpr, fromDateTime) {
    try {
        // Start from the current minute boundary with seconds and milliseconds reset
        const startDateTime = fromDateTime.startOfMinute();
        
        // Extract components
        let year = startDateTime.year;
        let month = startDateTime.month;
        let day = startDateTime.day;
        let hour = startDateTime.hour;
        let minute = startDateTime.minute;
        
        // Step 1: Calculate previous minute
        const minuteResult = prevInSetWithUnderflow(minute, cronExpr.minute);
        minute = minuteResult.value;
        let underflow = minuteResult.underflowed;
        
        // Step 2: Calculate previous hour (if underflow from minute)
        if (underflow) {
            const hourResult = prevInSetWithUnderflow(hour, cronExpr.hour);
            hour = hourResult.value;
            underflow = hourResult.underflowed;
            
            // Reset minute to maximum when going back an hour
            minute = maxInSet(cronExpr.minute);
        }
        
        // Step 3: Calculate previous day (if underflow from hour)
        if (underflow) {
            const validDays = validDaysInMonth(month, year, cronExpr.day);
            if (validDays.length === 0) {
                // No valid days in this month, go back to previous month
                underflow = true;
            } else {
                const dayResult = prevInSetWithUnderflow(day, validDays);
                if (dayResult.underflowed) {
                    // No more valid days in this month
                    underflow = true;
                } else {
                    day = dayResult.value;
                    underflow = false;
                    
                    // Reset hour and minute when going back a day
                    hour = maxInSet(cronExpr.hour);
                    minute = maxInSet(cronExpr.minute);
                }
            }
        }
        
        // Step 4: Calculate previous month (if underflow from day)
        if (underflow) {
            const monthResult = prevInSetWithUnderflow(month, cronExpr.month);
            month = monthResult.value;
            
            if (monthResult.underflowed) {
                // Underflowed to previous year
                year = year - 1;
            }
            
            // Set to last valid day in the new month
            const validDays = validDaysInMonth(month, year, cronExpr.day);
            if (validDays.length === 0) {
                // This should not happen for valid cron expressions
                throw new CronCalculationError(
                    "No valid days found in month",
                    cronExpr.original
                );
            }
            
            day = maxInSet(validDays);
            hour = maxInSet(cronExpr.hour);
            minute = maxInSet(cronExpr.minute);
        }
        
        // Step 5: Apply weekday constraints
        const candidateWeekday = getWeekday(year, month, day);
        if (!isValidInSet(candidateWeekday, cronExpr.weekday)) {
            const constraintResult = prevDateSatisfyingWeekdayConstraint(
                year, month, day,
                cronExpr.weekday,
                cronExpr.month,
                cronExpr.day
            );
            
            if (constraintResult) {
                year = constraintResult.year;
                month = constraintResult.month;
                day = constraintResult.day;
                hour = maxInSet(cronExpr.hour);
                minute = maxInSet(cronExpr.minute);
            } else {
                // Could not satisfy constraints - return null
                return null;
            }
        }
        
        // Create the result DateTime using Luxon and convert to our DateTime structure
        const luxonDateTime = startDateTime._luxonDateTime.set({
            year,
            month,
            day,
            hour,
            minute,
            second: 0,
            millisecond: 0
        });
        
        const resultDateTime = fromLuxon(luxonDateTime);
        
        // Ensure the result is actually before the input time
        if (resultDateTime.isAfter(fromDateTime)) {
            return null;
        }
        
        return resultDateTime;
        
    } catch (error) {
        if (isCronCalculationError(error)) {
            throw error;
        }
        
        // For previous calculations, we're more lenient with errors
        // and return null instead of throwing in many cases
        return null;
    }
}

module.exports = {
    calculatePreviousExecution,
    isCronCalculationError,
};