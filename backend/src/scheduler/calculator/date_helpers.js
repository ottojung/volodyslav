/**
 * Date manipulation utilities for mathematical cron algorithm.
 * Provides timezone-aware date operations while working with the DateTime abstraction.
 */

const { weekdayNameToCronNumber, dateTimeFromObject, fromObject } = require("../../datetime");

/**
 * Gets the number of days in a given month, accounting for leap years.
 * @param {number} month - Month (1-12)
 * @param {number} year - Year
 * @returns {number} Number of days in the month
 */
function daysInMonth(month, year) {
    // Month is 1-based in cron expressions
    const daysInMonths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    
    if (month < 1 || month > 12) {
        throw new Error(`Invalid month: ${month}. Must be between 1 and 12.`);
    }
    
    if (month === 2 && isLeapYear(year)) {
        return 29;
    }
    
    const days = daysInMonths[month - 1];
    if (days === undefined) {
        throw new Error(`Internal error: Invalid month index: ${month - 1}`);
    }
    return days;
}

/**
 * Checks if a year is a leap year.
 * @param {number} year - Year to check
 * @returns {boolean}
 */
function isLeapYear(year) {
    return (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
}

/**
 * Gets valid days for a given month and year from a day boolean mask.
 * @param {number} month - Month (1-12)
 * @param {number} year - Year
 * @param {boolean[]} dayMask - Boolean mask of valid days from cron expression
 * @returns {number[]} Array of valid days that exist in the given month
 */
function validDaysInMonth(month, year, dayMask) {
    const maxDay = daysInMonth(month, year);
    const validDays = [];
    
    for (let day = 1; day <= maxDay; day++) {
        if (dayMask[day]) {
            validDays.push(day);
        }
    }
    
    return validDays;
}

/**
 * Gets the weekday number (0=Sunday) for a given date.
 * @param {number} year - Year
 * @param {number} month - Month (1-12)
 * @param {number} day - Day
 * @returns {number} Weekday number (0=Sunday, 1=Monday, ..., 6=Saturday)
 */
function getWeekday(year, month, day) {
    // Use Luxon DateTime to get weekday
    const luxonDate = dateTimeFromObject({ year, month, day }, { zone: 'utc' });
    // Luxon weekday: 1=Monday, 2=Tuesday, ..., 7=Sunday
    // Convert to cron format: 0=Sunday, 1=Monday, ..., 6=Saturday
    const luxonWeekday = luxonDate.luxonWeekday;
    return luxonWeekday === 7 ? 0 : luxonWeekday; // Convert Sunday from 7 to 0
}

/**
 * Converts a DateTime weekday name to cron number.
 * @param {import('../../datetime').DateTime} dateTime
 * @returns {number} Cron weekday number (0=Sunday)
 */
function dateTimeWeekdayToCronNumber(dateTime) {
    return weekdayNameToCronNumber(dateTime.weekday);
}

/**
 * Advances a date by a number of days.
 * @param {number} year - Year
 * @param {number} month - Month (1-12)
 * @param {number} day - Day
 * @param {number} days - Number of days to advance
 * @returns {{year: number, month: number, day: number}}
 */
function addDays(year, month, day, days) {
    const luxonDate = dateTimeFromObject({ year, month, day }, { zone: 'utc' });
    const advancedDate = luxonDate.advance(fromObject({ days }));
    
    return {
        year: advancedDate.year,
        month: advancedDate.month,
        day: advancedDate.day
    };
}

/**
 * Subtracts a number of days from a date.
 * @param {number} year - Year
 * @param {number} month - Month (1-12)
 * @param {number} day - Day
 * @param {number} days - Number of days to subtract
 * @returns {{year: number, month: number, day: number}}
 */
function subtractDays(year, month, day, days) {
    return addDays(year, month, day, -days);
}

/**
 * Finds the next date that satisfies weekday constraints.
 * @param {number} year - Starting year
 * @param {number} month - Starting month (1-12)
 * @param {number} day - Starting day
 * @param {boolean[]} weekdayMask - Valid weekdays boolean mask from cron expression
 * @param {boolean[]} monthMask - Valid months boolean mask from cron expression
 * @param {boolean[]} dayMask - Valid days boolean mask from cron expression
 * @returns {{year: number, month: number, day: number}|null}
 */
function nextDateSatisfyingWeekdayConstraint(year, month, day, weekdayMask, monthMask, dayMask) {
    // Try the next 7 days to find a valid weekday
    for (let offset = 0; offset < 7; offset++) {
        const candidateDate = addDays(year, month, day, offset);
        const candidateWeekday = getWeekday(candidateDate.year, candidateDate.month, candidateDate.day);
        
        if (weekdayMask[candidateWeekday] &&
            monthMask[candidateDate.month] &&
            validDaysInMonth(candidateDate.month, candidateDate.year, dayMask).includes(candidateDate.day)) {
            return candidateDate;
        }
    }
    
    return null;
}

/**
 * Finds the previous date that satisfies weekday constraints.
 * @param {number} year - Starting year
 * @param {number} month - Starting month (1-12)
 * @param {number} day - Starting day
 * @param {boolean[]} weekdayMask - Valid weekdays boolean mask from cron expression
 * @param {boolean[]} monthMask - Valid months boolean mask from cron expression
 * @param {boolean[]} dayMask - Valid days boolean mask from cron expression
 * @returns {{year: number, month: number, day: number}|null}
 */
function prevDateSatisfyingWeekdayConstraint(year, month, day, weekdayMask, monthMask, dayMask) {
    // Try the previous 7 days to find a valid weekday
    for (let offset = 0; offset < 7; offset++) {
        const candidateDate = subtractDays(year, month, day, offset);
        const candidateWeekday = getWeekday(candidateDate.year, candidateDate.month, candidateDate.day);
        
        if (weekdayMask[candidateWeekday] &&
            monthMask[candidateDate.month] &&
            validDaysInMonth(candidateDate.month, candidateDate.year, dayMask).includes(candidateDate.day)) {
            return candidateDate;
        }
    }
    
    return null;
}

/**
 * Finds the next date that satisfies DOM/DOW OR constraints.
 * When both DOM and DOW are restricted, finds the next date that satisfies EITHER constraint.
 * @param {number} year - Starting year
 * @param {number} month - Starting month (1-12)
 * @param {number} day - Starting day
 * @param {boolean[]} weekdayMask - Valid weekdays boolean mask from cron expression
 * @param {boolean[]} monthMask - Valid months boolean mask from cron expression
 * @param {boolean[]} dayMask - Valid days boolean mask from cron expression
 * @param {boolean} useOrLogic - Whether to use OR logic (true) or AND logic (false)
 * @returns {{year: number, month: number, day: number}|null}
 */
function nextDateSatisfyingDomDowConstraints(year, month, day, weekdayMask, monthMask, dayMask, useOrLogic = false) {
    // First check if the current date already satisfies the constraints (offset=0)
    // Then try up to 400 days to find a valid date
    for (let offset = 0; offset < 400; offset++) {
        const candidateDate = addDays(year, month, day, offset);
        const candidateWeekday = getWeekday(candidateDate.year, candidateDate.month, candidateDate.day);
        
        // Must always satisfy month constraint
        if (!monthMask[candidateDate.month]) {
            continue;
        }

        const validDays = validDaysInMonth(candidateDate.month, candidateDate.year, dayMask);
        const domMatches = validDays.includes(candidateDate.day);
        const dowMatches = weekdayMask[candidateWeekday];
        
        if (useOrLogic) {
            // OR logic: either DOM or DOW must match
            if (domMatches || dowMatches) {
                return candidateDate;
            }
        } else {
            // AND logic: both DOM and DOW must match  
            if (domMatches && dowMatches) {
                return candidateDate;
            }
        }
    }
    
    return null;
}

/**
 * Finds the previous date that satisfies DOM/DOW OR constraints.
 * When both DOM and DOW are restricted, finds the previous date that satisfies EITHER constraint.
 * @param {number} year - Starting year
 * @param {number} month - Starting month (1-12)
 * @param {number} day - Starting day
 * @param {boolean[]} weekdayMask - Valid weekdays boolean mask from cron expression
 * @param {boolean[]} monthMask - Valid months boolean mask from cron expression
 * @param {boolean[]} dayMask - Valid days boolean mask from cron expression
 * @param {boolean} useOrLogic - Whether to use OR logic (true) or AND logic (false)
 * @returns {{year: number, month: number, day: number}|null}
 */
function prevDateSatisfyingDomDowConstraints(year, month, day, weekdayMask, monthMask, dayMask, useOrLogic = false) {
    // Try up to 400 days (over a year) to find a valid date
    for (let offset = 0; offset < 400; offset++) {
        const candidateDate = subtractDays(year, month, day, offset);
        const candidateWeekday = getWeekday(candidateDate.year, candidateDate.month, candidateDate.day);
        
        // Must always satisfy month constraint
        if (!monthMask[candidateDate.month]) {
            continue;
        }

        const validDays = validDaysInMonth(candidateDate.month, candidateDate.year, dayMask);
        const domMatches = validDays.includes(candidateDate.day);
        const dowMatches = weekdayMask[candidateWeekday];
        
        if (useOrLogic) {
            // OR logic: either DOM or DOW must match
            if (domMatches || dowMatches) {
                return candidateDate;
            }
        } else {
            // AND logic: both DOM and DOW must match  
            if (domMatches && dowMatches) {
                return candidateDate;
            }
        }
    }
    
    return null;
}

module.exports = {
    daysInMonth,
    isLeapYear,
    validDaysInMonth,
    getWeekday,
    dateTimeWeekdayToCronNumber,
    addDays,
    subtractDays,
    nextDateSatisfyingWeekdayConstraint,
    prevDateSatisfyingWeekdayConstraint,
    nextDateSatisfyingDomDowConstraints,
    prevDateSatisfyingDomDowConstraints,
};