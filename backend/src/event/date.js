const { format: formatDateTime } = require("../datetime");

/**
 * @typedef {object} Capabilities
 * @property {import('../datetime').Datetime} datetime - Datetime capability.
 */

/**
 * Formats a date to the local timezone.
 * @param {Capabilities} capabilities
 * @param {import('../datetime').DateTime} date - The date to format.
 * @returns {string} - The formatted date string in the format YYYY-MM-DDTHH:mm:ssZZ.
 */
function format(capabilities, date) {
    // Format: YYYY-MM-DDTHH:mm:ssZZ (local timezone, e.g. 2025-05-22T15:30:00+0200)
    const tzName = capabilities.datetime.timeZone();
    return formatDateTime(date, "yyyy-MM-dd'T'HH:mm:ssZZZ", tzName);
}

module.exports = {
    format,
};
