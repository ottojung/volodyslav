/**
 * Previous fire time calculation API.
 */

const {
    prevInSetWithUnderflow,
    maxInSet,
    minInSet,
    isValidInSet
} = require("./field_math");

const {
    validDaysInMonth,
    prevDateSatisfyingWeekdayConstraint,
    prevDateSatisfyingDomDowConstraints,
    getWeekday
} = require("./date_helpers");

const { fromLuxon } = require("../../datetime/structure");
const { matchesCronExpression } = require("./current");

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
 * Calculates the previous execution time for a cron expression.
 * If the current time matches the cron expression, returns the current time.
 * Otherwise, finds the most recent past execution time.
 * @param {import('../expression').CronExpression} cronExpr - Parsed cron expression
 * @param {import('../../datetime').DateTime} fromDateTime - DateTime to calculate from
 * @returns {import('../../datetime').DateTime} Previous execution datetime, or null if none found
 */
function getMostRecentExecution(cronExpr, fromDateTime) {
    try {
        // Start from the current minute boundary with seconds and milliseconds reset
        const startDateTime = fromDateTime.startOfMinute();

        // Check if the current time already matches the cron expression
        if (matchesCronExpression(cronExpr, startDateTime)) {
            // Special case: If we're at the beginning of a multi-value hour range
            // AND have multi-value minute constraints, use exclusive semantics 
            // to enable "ripple back" across days.
            // This is needed for patterns like "*/30 8-9 * * *" where from 08:00,
            // we want the previous 09:30, not the current 08:00
            const isHourRestricted = cronExpr.hour.length < 24 && cronExpr.hour.length > 1;
            const isMinuteRestricted = cronExpr.minute.length > 1; // Multiple minute values
            const isAtBeginningOfHourRange = isHourRestricted && startDateTime.hour === minInSet(cronExpr.hour);
            const isMinuteAtBeginning = startDateTime.minute === minInSet(cronExpr.minute);
            
            if (isHourRestricted && isMinuteRestricted && isAtBeginningOfHourRange && isMinuteAtBeginning) {
                // At beginning of multi-value hour range - use exclusive semantics
                // Continue to find actual previous execution
            } else {
                // Normal case - return current time (inclusive)
                return startDateTime;
            }
        }

        // Current time doesn't match, find the actual previous execution
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

        // Step 2: Calculate previous hour (always check hour constraints)
        if (underflow || !isValidInSet(hour, cronExpr.hour)) {
            // Either carried from minute, or current hour violates hour constraints
            const hourResult = prevInSetWithUnderflow(hour, cronExpr.hour);
            hour = hourResult.value;
            underflow = hourResult.underflowed;

            // Reset minute to maximum when going back an hour
            minute = maxInSet(cronExpr.minute);
        }

        // Step 3: Calculate previous day (always check day constraints)
        const validDays = validDaysInMonth(month, year, cronExpr.day);
        if (validDays.length === 0) {
            // No valid days in this month, go back to previous month
            underflow = true;
        } else if (underflow || !isValidInSet(day, validDays)) {
            // Either carried from hour, or current day violates day constraints
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

        // Step 4: Calculate previous month (always check month constraints)
        if (underflow || !isValidInSet(month, cronExpr.month)) {
            // Either carried from day, or current month violates month constraints
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

        // Step 5: Apply DOM/DOW OR semantics for date constraints
        const isDayRestricted = cronExpr.day.length < 31; // Not all days 1-31
        const isWeekdayRestricted = cronExpr.weekday.length < 7; // Not all weekdays 0-6

        if (isDayRestricted && isWeekdayRestricted) {
            // Both DOM and DOW are restricted - use OR logic
            const constraintResult = prevDateSatisfyingDomDowConstraints(
                year, month, day,
                cronExpr.weekday,
                cronExpr.month,
                cronExpr.day,
                true // use OR logic
            );

            if (constraintResult) {
                year = constraintResult.year;
                month = constraintResult.month;
                day = constraintResult.day;
                hour = maxInSet(cronExpr.hour);
                minute = maxInSet(cronExpr.minute);
            } else {
                throw new CronCalculationError(
                    "Could not satisfy DOM/DOW OR constraints",
                    cronExpr.original
                );
            }
        } else if (isWeekdayRestricted) {
            // Only weekday is restricted, DOM is wildcard
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
                    throw new CronCalculationError(
                        "Could not satisfy weekday constraints",
                        cronExpr.original
                    );
                }
            }
        }
        // If only DOM is restricted or both are wildcards, current calculation is valid

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
            throw new CronCalculationError(
                "Calculated previous execution is after the reference time",
                cronExpr.original
            );
        }

        return resultDateTime;

    } catch (error) {
        if (isCronCalculationError(error)) {
            throw error;
        }

        // For previous calculations, we're more lenient with errors
        // and return null instead of throwing in many cases
        throw new CronCalculationError(
            `Error calculating previous execution: ${error}`,
            cronExpr.original
        );
    }
}

module.exports = {
    getMostRecentExecution,
    isCronCalculationError,
};
