const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");

dayjs.extend(utc);
dayjs.extend(timezone);

/** @typedef {import('../date_value').DateValue} DateValue */

/**
 * Formats a date to the local timezone.
 * @param {DateValue} date - The date to format.
 * @returns {string} - The formatted date string in the format YYYY-MM-DDTHH:mm:ssZZ.
 */
function format(date) {
    // Format: YYYY-MM-DDTHH:mm:ssZZ (local timezone, e.g. 2025-05-22T15:30:00+0200)
    const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return dayjs(date.toISOString()).tz(tzName).format("YYYY-MM-DDTHH:mm:ssZZ");
}

module.exports = {
    format,
};
