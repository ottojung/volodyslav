
const { fromISOString, toISOString, mtime, tryDeserialize, DateTimeTryDeserializeError, isDateTimeTryDeserializeError } = require('./conversions');
const { make } = require('./capability');
const { weekdayNameToCronNumber, cronNumberToWeekdayName, isWeekdayName, getAllWeekdayNames } = require('./weekday');
const { isDateTime } = require('./structure');
const { isDuration, difference, fromMilliseconds, fromSeconds, fromMinutes, fromHours, fromDays, fromWeeks, fromObject } = require('./duration');
const { fromObject: dateTimeFromObject, format } = require('./factories');
const { getMaxDaysInMonth } = require('./month');

/** @typedef {import('./capability').Datetime} Datetime */
/** @typedef {import('./structure').DateTime} DateTime */
/** @typedef {import('./weekday').WeekdayName} WeekdayName */
/** @typedef {import('./duration').Duration} Duration */

module.exports = {
    make,
    isDateTime,
    mtime,
    fromISOString,
    toISOString,
    tryDeserialize,
    DateTimeTryDeserializeError,
    isDateTimeTryDeserializeError,
    weekdayNameToCronNumber,
    cronNumberToWeekdayName,
    isWeekdayName,
    getAllWeekdayNames,
    // Duration utilities
    isDuration,
    difference,
    fromMilliseconds,
    fromSeconds,
    fromMinutes,
    fromHours,
    fromDays,
    fromWeeks,
    fromObject,
    // DateTime factories
    dateTimeFromObject,
    format,
    // Month utilities
    getMaxDaysInMonth,
};
