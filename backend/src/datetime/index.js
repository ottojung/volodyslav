
const { fromISOString, toISOString, mtime } = require('./conversions');
const { make } = require('./capability');
const { weekdayNameToCronNumber, cronNumberToWeekdayName, isWeekdayName, getAllWeekdayNames } = require('./weekday');
const { isDateTime } = require('./structure');
const { difference, fromMilliseconds, fromMinutes, fromHours, fromDays, fromWeeks, fromObject } = require('./duration');
const { fromObject: dateTimeFromObject, format } = require('./factories');

/** @typedef {import('./capability').Datetime} Datetime */
/** @typedef {import('./structure').DateTime} DateTime */
/** @typedef {import('./weekday').WeekdayName} WeekdayName */

module.exports = {
    make,
    isDateTime,
    mtime,
    fromISOString,
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
    fromObject,
    // DateTime factories
    dateTimeFromObject,
    format,
};
