/**
 * This module provides a function to format a timestamp from a filename
 * into a Date object. The filename is expected to start with a timestamp
 * in the format YYYYMMDDThhmmssZ followed by a dot and an extension.
 */

const { fromISOString } = require("./datetime");

class FilenameDoesNotEncodeDate extends Error {
    /**
     * @param {string} message
     * @param {string} filename
     */
    constructor(message, filename) {
        super(message);
        this.filename = filename;
    }
}

/**
 * @param {unknown} object
 * @returns {object is FilenameDoesNotEncodeDate}
 */
function isFilenameDoesNotEncodeDate(object) {
    return object instanceof FilenameDoesNotEncodeDate;
}

/**
 * @param {string} filename
 * @returns {import('./datetime').DateTime}
*/
function formatFileTimestamp(filename) {
    // 1) extract the basic‐ISO timestamp (YYYYMMDDThhmmssZ)
    const m = filename.match(/^(\d{8}T\d{6}Z)[.].*/);
    if (!m)
        throw new FilenameDoesNotEncodeDate(
            `Filename ${JSON.stringify(
                filename
            )} does not start with YYYYMMDDThhmmssZ`,
            filename
        );

    const basic = m[1];

    // 2) get Date object from basic timestamp
    const dateObject = formatTimeStamp(basic);

    if (dateObject === undefined) {
        // This should ideally not be hit if 'basic' is from the regex match above
        // and format_time_stamp's regex is correct.
        throw new Error(
            `Failed to parse valid Date from timestamp string: ${basic}`
        );
    }

    return dateObject;
}

/**
 * @param {string | undefined} basic - String in YYYYMMDDThhmmssZ format
 * @returns {import('./datetime').DateTime | undefined}
*/
function formatTimeStamp(basic) {
    if (basic === undefined) {
        return undefined;
    }

    // Convert YYYYMMDDThhmmssZ to YYYY-MM-DDTHH:mm:ssZ
    const isoUTC = basic.replace(
        /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/,
        "$1-$2-$3T$4:$5:$6Z"
    );

    // If basic didn't match the regex, .replace returns the original string.
    if (isoUTC === basic) {
        return undefined;
    }

    const match = isoUTC.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z/);
    const d = fromISOString(isoUTC);
    if (
        !match ||
        !d.isValid
    ) {
        return undefined;
    }

    // Validate that the parsed date components match the original string
    // by comparing the date components directly instead of string slicing
    if (
        !match[1] || !match[2] || !match[3] || !match[4] || !match[5] || !match[6] ||
        d.year !== parseInt(match[1], 10) ||      // year
        d.month !== parseInt(match[2], 10) ||     // month  
        d.day !== parseInt(match[3], 10) ||       // day
        d.hour !== parseInt(match[4], 10) ||      // hour
        d.minute !== parseInt(match[5], 10) ||    // minute
        d.second !== parseInt(match[6], 10)       // second
    ) {
        return undefined;
    }

    return d;
}

module.exports = {
    formatFileTimestamp,
    isFilenameDoesNotEncodeDate,
};
