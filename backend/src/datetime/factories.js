/**
 * DateTime factory functions and formatting utilities.
 */

const { fromLuxon } = require('./structure');
const { DateTime: LuxonDateTime } = require("luxon");

/** @typedef {import('./structure').DateTime} DateTime */

/**
 * Create a DateTime from an object specification with optional timezone.
 * @param {object} spec - DateTime specification object
 * @param {number} spec.year - Year
 * @param {number} spec.month - Month (1-12)
 * @param {number} spec.day - Day (1-31)
 * @param {number} [spec.hour] - Hour (0-23)
 * @param {number} [spec.minute] - Minute (0-59)
 * @param {number} [spec.second] - Second (0-59)
 * @param {number} [spec.millisecond] - Millisecond (0-999)
 * @param {object} [options] - Options object
 * @param {string} [options.zone] - Timezone (e.g., 'utc', 'America/New_York')
 * @returns {DateTime} DateTime object
 */
function fromObject(spec, options = {}) {
    return fromLuxon(LuxonDateTime.fromObject(spec, options));
}

/**
 * Create a DateTime from milliseconds and set timezone.
 * @param {number} millis - Milliseconds since epoch
 * @param {string} timezone - Timezone to set (e.g., 'UTC', 'America/New_York')
 * @returns {DateTime} DateTime object with timezone set
 */
function fromMillisWithZone(millis, timezone) {
    return fromLuxon(LuxonDateTime.fromMillis(millis).setZone(timezone));
}

/**
 * Format a DateTime with the given pattern.
 * @param {DateTime} dateTime - DateTime to format
 * @param {string} pattern - Format pattern (e.g., "yyyy-MM-dd'T'HH:mm:ssZZZ")
 * @param {string} [timezone] - Optional timezone to format in
 * @returns {string} Formatted date string
 */
function format(dateTime, pattern, timezone) {
    let luxonDateTime = LuxonDateTime.fromMillis(dateTime.getTime());
    if (timezone) {
        luxonDateTime = luxonDateTime.setZone(timezone);
    }
    return luxonDateTime.toFormat(pattern);
}

module.exports = {
    fromObject,
    fromMillisWithZone,
    format,
};