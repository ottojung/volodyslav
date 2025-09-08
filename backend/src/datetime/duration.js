/**
 * Duration utilities using Luxon Duration.
 */

const luxon = require("luxon");

/** @typedef {import('luxon').Duration} Duration */

/**
 * @param {unknown} value 
 * @returns {value is Duration}
 */
function isDuration(value) {
    return luxon.Duration.isDuration(value);
}

/**
 * Calculate the difference between two DateTimes as a Duration.
 * @param {import('./structure').DateTime} laterDateTime - The later DateTime
 * @param {import('./structure').DateTime} earlierDateTime - The earlier DateTime
 * @returns {import('luxon').Duration} Duration between the two DateTimes
 */
function difference(laterDateTime, earlierDateTime) {
    return laterDateTime.diff(earlierDateTime);
}

/**
 * Create a Duration from milliseconds.
 * @param {number} ms - Milliseconds
 * @returns {Duration} Duration object
 */
function fromMilliseconds(ms) {
    return luxon.Duration.fromMillis(ms);
}

 /**
 * Create a Duration from seconds.
 * @param {number} seconds - Seconds
 * @returns {Duration} Duration object
 */
function fromSeconds(seconds) {
    return luxon.Duration.fromMillis(seconds * 1000);
}

/**
 * Create a Duration from minutes.
 * @param {number} minutes - Minutes
 * @returns {Duration} Duration object
 */
function fromMinutes(minutes) {
    return luxon.Duration.fromObject({ minutes });
}

/**
 * Create a Duration from hours.
 * @param {number} hours - Hours
 * @returns {Duration} Duration object
 */
function fromHours(hours) {
    return luxon.Duration.fromObject({ hours });
}

/**
 * Create a Duration from days.
 * @param {number} days - Days
 * @returns {Duration} Duration object
 */
function fromDays(days) {
    return luxon.Duration.fromObject({ days });
}

/**
 * Create a Duration from weeks.
 * @param {number} weeks - Weeks
 * @returns {Duration} Duration object
 */
function fromWeeks(weeks) {
    return luxon.Duration.fromObject({ weeks });
}

/**
 * Create a Duration from an object specification.
 * @param {object} spec - Duration specification object
 * @param {number} [spec.years] - Years
 * @param {number} [spec.quarters] - Quarters
 * @param {number} [spec.months] - Months
 * @param {number} [spec.weeks] - Weeks
 * @param {number} [spec.days] - Days
 * @param {number} [spec.hours] - Hours
 * @param {number} [spec.minutes] - Minutes
 * @param {number} [spec.seconds] - Seconds
 * @param {number} [spec.milliseconds] - Milliseconds
 * @returns {Duration} Duration object
 */
function fromObject(spec) {
    return luxon.Duration.fromObject(spec);
}

module.exports = {
    isDuration,
    difference,
    fromMilliseconds,
    fromSeconds,
    fromMinutes,
    fromHours,
    fromDays,
    fromWeeks,
    fromObject,
};
