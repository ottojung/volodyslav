/**
 * Next execution calculation API.
 */

const {
    nextInSetWithRollover,
    minInSet,
    isValidInSet
} = require("./field_math");

const {
    validDaysInMonth,
    nextDateSatisfyingWeekdayConstraint,
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
 * Calculates the next execution time for a cron expression using mathematical field calculation.
 * @param {import('../expression').CronExpression} cronExpr - Parsed cron expression
 * @param {import('../../datetime').DateTime} fromDateTime - DateTime to calculate from
 * @returns {import('../../datetime').DateTime} Next execution datetime
 * @throws {CronCalculationError} If next execution cannot be calculated
 */
function getNextExecution(cronExpr, fromDateTime) {
    try {
        // Start from the next minute boundary with seconds and milliseconds reset
        const startDateTime = fromDateTime.startOfNextMinuteForIteration();

        // Extract components
        let year = startDateTime.year;
        let month = startDateTime.month;
        let day = startDateTime.day;
        let hour = startDateTime.hour;
        let minute = startDateTime.minute;

        // Check if the starting time already matches all constraints
        const validDays = validDaysInMonth(month, year, cronExpr.day);
        const startWeekday = getWeekday(year, month, day);

        const currentMatches = (
            isValidInSet(minute, cronExpr.minute) &&
            isValidInSet(hour, cronExpr.hour) &&
            isValidInSet(day, validDays) &&
            isValidInSet(month, cronExpr.month) &&
            (cronExpr.weekday.length === 7 || isValidInSet(startWeekday, cronExpr.weekday))
        );

        if (currentMatches) {
            // Current time already matches, return it
            return startDateTime;
        }

        // Step 1: Calculate next minute
        const minuteResult = nextInSetWithRollover(minute, cronExpr.minute);
        minute = minuteResult.value;
        let carry = minuteResult.rolledOver;

        // Step 2: Calculate next hour (if carry from minute)
        if (carry) {
            const hourResult = nextInSetWithRollover(hour, cronExpr.hour);
            hour = hourResult.value;
            carry = hourResult.rolledOver;

            // Reset minute to minimum when advancing hour
            minute = minInSet(cronExpr.minute);
        }

        // Step 3: Calculate next day (always check day constraints)
        const currentValidDays = validDaysInMonth(month, year, cronExpr.day);
        if (currentValidDays.length === 0) {
            // No valid days in this month, advance to next month
            carry = true;
        } else if (carry || !isValidInSet(day, currentValidDays)) {
            // Either carried from hour, or current day violates day constraints
            const dayResult = nextInSetWithRollover(day, currentValidDays);
            if (dayResult.rolledOver) {
                // No more valid days in this month
                carry = true;
            } else {
                day = dayResult.value;
                carry = false;

                // Reset hour and minute when advancing day
                hour = minInSet(cronExpr.hour);
                minute = minInSet(cronExpr.minute);
            }
        }

        // Step 4: Calculate next month (always check month constraints)
        if (carry || !isValidInSet(month, cronExpr.month)) {
            // Either carried from day, or current month violates month constraints
            const monthResult = nextInSetWithRollover(month, cronExpr.month);
            month = monthResult.value;

            if (monthResult.rolledOver) {
                // Rolled over to next year
                year = year + 1;
            }

            // Set to first valid day in the new month
            const newValidDays = validDaysInMonth(month, year, cronExpr.day);
            if (newValidDays.length === 0) {
                // This should not happen for valid cron expressions
                throw new CronCalculationError(
                    "No valid days found in month",
                    cronExpr.original
                );
            }

            day = minInSet(newValidDays);
            hour = minInSet(cronExpr.hour);
            minute = minInSet(cronExpr.minute);
        }

        // Step 5: Apply weekday constraints only if weekday constraint exists
        if (cronExpr.weekday.length < 7) { // Not all weekdays are allowed
            const candidateWeekday = getWeekday(year, month, day);
            if (!isValidInSet(candidateWeekday, cronExpr.weekday)) {
                const constraintResult = nextDateSatisfyingWeekdayConstraint(
                    year, month, day,
                    cronExpr.weekday,
                    cronExpr.month,
                    cronExpr.day
                );

                if (constraintResult) {
                    year = constraintResult.year;
                    month = constraintResult.month;
                    day = constraintResult.day;
                    hour = minInSet(cronExpr.hour);
                    minute = minInSet(cronExpr.minute);
                } else {
                    // This should be extremely rare for valid cron expressions
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

        return fromLuxon(luxonDateTime);

    } catch (error) {
        if (isCronCalculationError(error)) {
            throw error;
        }

        throw new CronCalculationError(
            `Calculation failed: ${error instanceof Error ? error.message : String(error)}`,
            cronExpr.original
        );
    }
}

module.exports = {
    getNextExecution,
    isCronCalculationError,
};
