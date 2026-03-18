const { format: formatDateTime } = require("../datetime");

/**
 * Formats a date while preserving the date timezone.
 * @param {object} capabilities - Unused legacy compatibility parameter.
 * @param {import('../datetime').DateTime} date - The date to format.
 * @returns {string} - The formatted date string in the format YYYY-MM-DDTHH:mm:ssZZ.
 */
function format(capabilities, date) {
    void capabilities;
    // Format: YYYY-MM-DDTHH:mm:ssZZ in the date's own timezone/offset.
    return formatDateTime(date, "yyyy-MM-dd'T'HH:mm:ssZZZ");
}

module.exports = {
    format,
};
