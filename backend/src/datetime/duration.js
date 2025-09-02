/**
 * Duration utilities using Luxon Duration.
 */

const { Duration } = require("luxon");

/**
 * Calculate the difference between two DateTimes as a Duration.
 * @param {import('./structure').DateTime} laterDateTime - The later DateTime
 * @param {import('./structure').DateTime} earlierDateTime - The earlier DateTime
 * @returns {import('luxon').Duration} Duration between the two DateTimes
 */
function difference(laterDateTime, earlierDateTime) {
    return laterDateTime._luxonDateTime.diff(earlierDateTime._luxonDateTime);
}

/**
 * Create a Duration from milliseconds.
 * @param {number} ms - Milliseconds
 * @returns {import('luxon').Duration} Duration object
 */
function fromMilliseconds(ms) {
    return Duration.fromMillis(ms);
}

/**
 * Create a Duration from minutes.
 * @param {number} minutes - Minutes
 * @returns {import('luxon').Duration} Duration object
 */
function fromMinutes(minutes) {
    return Duration.fromObject({ minutes });
}

/**
 * Create a Duration from hours.
 * @param {number} hours - Hours
 * @returns {import('luxon').Duration} Duration object
 */
function fromHours(hours) {
    return Duration.fromObject({ hours });
}

/**
 * Create a Duration from days.
 * @param {number} days - Days
 * @returns {import('luxon').Duration} Duration object
 */
function fromDays(days) {
    return Duration.fromObject({ days });
}

/**
 * Create a Duration from weeks.
 * @param {number} weeks - Weeks
 * @returns {import('luxon').Duration} Duration object
 */
function fromWeeks(weeks) {
    return Duration.fromObject({ weeks });
}

module.exports = {
    difference,
    fromMilliseconds,
    fromMinutes,
    fromHours,
    fromDays,
    fromWeeks,
};