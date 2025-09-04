
const { fromEpochMs, fromISOString, toEpochMs, toISOString, mtime } = require('./conversions');
const { make } = require('./capability');
const { weekdayNameToCronNumber, cronNumberToWeekdayName, isWeekdayName, getAllWeekdayNames } = require('./weekday');
const { isDateTime } = require('./structure');
const { difference, fromMinutes, fromHours, fromDays, fromWeeks, fromObject } = require('./duration');
const { fromObject: dateTimeFromObject, fromMillisWithZone, format } = require('./factories');

/** @typedef {import('./capability').Datetime} Datetime */
/** @typedef {import('./structure').DateTime} DateTime */
/** @typedef {import('./weekday').WeekdayName} WeekdayName */

module.exports = {
    make,
    isDateTime,
    mtime,
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
    fromMinutes,
    fromHours,
    fromDays,
    fromWeeks,
    fromObject,
    // DateTime factories
    dateTimeFromObject,
    fromMillisWithZone,
    format,
};
