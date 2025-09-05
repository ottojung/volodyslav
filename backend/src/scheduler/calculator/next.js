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
    nextDateSatisfyingDomDowConstraints,
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

        // Check basic constraints (minute, hour, month)
        const basicMatch = (
            isValidInSet(minute, cronExpr.minute) &&
            isValidInSet(hour, cronExpr.hour) &&
            isValidInSet(month, cronExpr.month)
        );

        if (basicMatch) {
            // Check DOM/DOW OR semantics
            const isDayRestricted = cronExpr.day.length < 31; // Not all days 1-31
            const isWeekdayRestricted = cronExpr.weekday.length < 7; // Not all weekdays 0-6

            let dateConstraintMatches;
            if (isDayRestricted && isWeekdayRestricted) {
                // Both are restricted - use OR logic
                dateConstraintMatches = isValidInSet(day, validDays) || isValidInSet(startWeekday, cronExpr.weekday);
            } else {
                // At least one is wildcard - use AND logic
                dateConstraintMatches = isValidInSet(day, validDays) && isValidInSet(startWeekday, cronExpr.weekday);
            }

            if (dateConstraintMatches) {
                // Current time already matches, return it
                return startDateTime;
            }
        }

        // Step 1: Calculate next minute
        const minuteResult = nextInSetWithRollover(minute, cronExpr.minute);
        minute = minuteResult.value;
        let carry = minuteResult.rolledOver;

        // Step 2: Calculate next hour (always check hour constraints)
        if (carry || !isValidInSet(hour, cronExpr.hour)) {
            // Either carried from minute, or current hour violates hour constraints
            const hourResult = nextInSetWithRollover(hour, cronExpr.hour);
            hour = hourResult.value;
            carry = hourResult.rolledOver;

            // Reset minute to minimum when advancing hour
            minute = minInSet(cronExpr.minute);
        }

        // Step 3: Find next valid date using DOM/DOW OR semantics
        // Start search from current day, but advance if hour needed to advance
        let searchYear = startDateTime.year;
        let searchMonth = startDateTime.month;
        let searchDay = startDateTime.day;

        // If hour had to advance due to constraints (not just carry), we need to start search from next day
        if (!carry && !isValidInSet(hour, cronExpr.hour)) {
            // Hour constraint failed on same day, advance to next day for search
            const nextDay = startDateTime.advance({ days: 1 });
            searchYear = nextDay.year;
            searchMonth = nextDay.month;
            searchDay = nextDay.day;
        } else if (carry) {
            // Carried from hour, already advanced to next day
            // Keep the current search position
        }

        const isDayRestricted = cronExpr.day.length < 31; // Not all days 1-31
        const isWeekdayRestricted = cronExpr.weekday.length < 7; // Not all weekdays 0-6

        if (isDayRestricted && isWeekdayRestricted) {
            // Both DOM and DOW are restricted - use OR logic
            const constraintResult = nextDateSatisfyingDomDowConstraints(
                searchYear, searchMonth, searchDay,
                cronExpr.weekday,
                cronExpr.month,
                cronExpr.day,
                true // use OR logic
            );

            if (constraintResult) {
                year = constraintResult.year;
                month = constraintResult.month;
                day = constraintResult.day;
                hour = minInSet(cronExpr.hour);
                minute = minInSet(cronExpr.minute);
            } else {
                throw new CronCalculationError(
                    "Could not satisfy DOM/DOW OR constraints",
                    cronExpr.original
                );
            }
        } else if (isWeekdayRestricted) {
            // Only weekday is restricted, DOM is wildcard - use existing helper
            const constraintResult = nextDateSatisfyingWeekdayConstraint(
                searchYear, searchMonth, searchDay,
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
                throw new CronCalculationError(
                    "Could not satisfy weekday constraints",
                    cronExpr.original
                );
            }
        } else if (isDayRestricted) {
            // Only DOM is restricted, DOW is wildcard - find next valid DOM
            let found = false;

            // Try up to 12 months to find a valid day
            for (let monthOffset = 0; monthOffset < 12; monthOffset++) {
                const currentMonth = ((searchMonth - 1 + monthOffset) % 12) + 1;
                const currentYear = searchYear + Math.floor((searchMonth - 1 + monthOffset) / 12);

                if (isValidInSet(currentMonth, cronExpr.month)) {
                    const validDays = validDaysInMonth(currentMonth, currentYear, cronExpr.day);
                    const startDay = monthOffset === 0 ? searchDay : 1;
                    
                    const validDay = validDays.find(d => d >= startDay);
                    if (validDay) {
                        year = currentYear;
                        month = currentMonth;
                        day = validDay;
                        hour = minInSet(cronExpr.hour);
                        minute = minInSet(cronExpr.minute);
                        found = true;
                        break;
                    }
                }
            }

            if (!found) {
                throw new CronCalculationError(
                    "Could not find valid day in any month",
                    cronExpr.original
                );
            }
        } else {
            // Neither DOM nor DOW is restricted - but still need to validate time constraints
            // If current computed time is earlier than the original time, we need the next day
            const testTime = startDateTime._luxonDateTime.set({
                year: searchYear,
                month: searchMonth,
                day: searchDay,
                hour: minInSet(cronExpr.hour),
                minute: minInSet(cronExpr.minute),
                second: 0,
                millisecond: 0
            });
            
            if (testTime.toMillis() <= fromDateTime._luxonDateTime.toMillis()) {
                // The computed time is not after the original time, advance to next day
                const nextDay = startDateTime.advance({ days: 1 });
                year = nextDay.year;
                month = nextDay.month;
                day = nextDay.day;
                hour = minInSet(cronExpr.hour);
                minute = minInSet(cronExpr.minute);
            } else {
                // Use current calculation
                year = searchYear;
                month = searchMonth;
                day = searchDay;
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
