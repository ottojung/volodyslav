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
    return laterDateTime.diff(earlierDateTime);
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
 * @returns {import('luxon').Duration} Duration object
 */
function fromObject(spec) {
    return Duration.fromObject(spec);
}

module.exports = {
    difference,
    fromMinutes,
    fromHours,
    fromDays,
    fromWeeks,
    fromObject,
};