/**
 * Previous fire time calculation API.
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
            // Current time matches - return it as the "most recent" execution
            return startDateTime;
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

        // Step 2: Calculate previous hour (if underflow from minute)
        if (underflow) {
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
        } else if (underflow || !validDays.includes(day)) {
            // Either carried from hour, or current day violates day constraints
            const prevDay = [...validDays].reverse().find(d => d < day);
            if (prevDay !== undefined) {
                day = prevDay;
                underflow = false;
                
                // Reset hour and minute when going back a day
                hour = maxInSet(cronExpr.hour);
                minute = maxInSet(cronExpr.minute);
            } else {
                // No more valid days in this month
                underflow = true;
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

            const maxDay = validDays[validDays.length - 1];
            if (maxDay === undefined) {
                throw new CronCalculationError(
                    "No valid days found in month after filtering",
                    cronExpr.original
                );
            }
            day = maxDay; // Get the last (maximum) valid day
            hour = maxInSet(cronExpr.hour);
            minute = maxInSet(cronExpr.minute);
        }

        // Step 5: Apply weekday constraints only if weekday constraint exists
        const isWeekdayWildcard = cronExpr.weekday.slice(0, 7).every(val => val === true);
        if (!isWeekdayWildcard) { // Not all weekdays are allowed
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
                    throw new CronCalculationError(
                        "Could not satisfy weekday constraints",
                        cronExpr.original
                    );
                }
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
            throw new CronCalculationError(
                "Calculated previous execution is after the reference time",
                cronExpr.original
            );
        }

        // For day-constrained crons, only return executions from the same day
        // This prevents returning yesterday's executions when today doesn't match the cron
        const isDayWildcard = cronExpr.day.slice(1, 32).every(val => val === true); // Check days 1-31
        if (!isDayWildcard) { // Day constraint exists (not all days allowed)
            if (resultDateTime.day !== fromDateTime.day ||
                resultDateTime.month !== fromDateTime.month ||
                resultDateTime.year !== fromDateTime.year) {
                // Previous execution is from a different day, don't consider it "recent"
                throw new CronCalculationError(
                    "Previous execution falls on a different day",
                    cronExpr.original
                );
            }
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
