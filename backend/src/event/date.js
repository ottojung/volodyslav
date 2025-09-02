const { DateTime: LuxonDateTime } = require("luxon");

/**
 * Formats a date to the local timezone.
 * @param {import('../datetime').DateTime} date - The date to format.
 * @returns {string} - The formatted date string in the format YYYY-MM-DDTHH:mm:ssZZ.
 */
function format(date) {
    // Format: YYYY-MM-DDTHH:mm:ssZZ (local timezone, e.g. 2025-05-22T15:30:00+0200)
    const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const luxonDateTime = LuxonDateTime.fromMillis(date.getTime()).setZone(tzName);
    return luxonDateTime.toFormat("yyyy-MM-dd'T'HH:mm:ssZZZ");
}

module.exports = {
    format,
};
