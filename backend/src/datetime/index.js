
const { fromEpochMs, fromISOString, toEpochMs, toISOString } = require('./conversions');
const { make } = require('./capability');
const { weekdayNameToCronNumber, cronNumberToWeekdayName, isWeekdayName, getAllWeekdayNames } = require('./weekday');
const { isDateTime } = require('./structure');
const { difference, fromMilliseconds, fromMinutes, fromHours, fromDays, fromWeeks } = require('./duration');

/** @typedef {import('./capability').Datetime} Datetime */
/** @typedef {import('./structure').DateTime} DateTime */
/** @typedef {import('./weekday').WeekdayName} WeekdayName */

module.exports = {
    make,
    isDateTime,
    fromEpochMs,
    fromISOString,
    toEpochMs,
    toISOString,
    weekdayNameToCronNumber,
    cronNumberToWeekdayName,
    isWeekdayName,
    getAllWeekdayNames,
    // Duration utilities
    difference,
    fromMilliseconds,
    fromMinutes,
    fromHours,
    fromDays,
    fromWeeks,
};
