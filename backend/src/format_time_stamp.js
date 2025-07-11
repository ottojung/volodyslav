/**
 * This module provides a function to format a timestamp from a filename
 * into a Date object. The filename is expected to start with a timestamp
 * in the format YYYYMMDDThhmmssZ followed by a dot and an extension.
 */

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
/**
 * @typedef {import('./date_value').DateValue} DateValue
 * @typedef {import('./datetime').Datetime} Datetime
 */

/**
 * @param {{ datetime: Datetime }} capabilities
 * @param {string} filename
 * @returns {DateValue}
 */
function formatFileTimestamp(capabilities, filename) {
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

    // 2) get DateValue from basic timestamp
    const dateObject = format_time_stamp(capabilities, basic);

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
 * @param {{ datetime: Datetime }} capabilities
 * @param {string | undefined} basic - String in YYYYMMDDThhmmssZ format
 * @returns {DateValue | undefined}
 */
function format_time_stamp(capabilities, basic) {
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
    const d = capabilities.datetime.fromString(isoUTC);
    if (
        !match ||
        isNaN(d.getTime()) ||
        d.getUTCFullYear() !== Number(match[1]) ||
        d.getUTCMonth() + 1 !== Number(match[2]) ||
        d.getUTCDate() !== Number(match[3]) ||
        d.getUTCHours() !== Number(match[4]) ||
        d.getUTCMinutes() !== Number(match[5]) ||
        d.getUTCSeconds() !== Number(match[6])
    ) {
        return undefined;
    }

    return d;
}

module.exports = {
    formatFileTimestamp,
    isFilenameDoesNotEncodeDate,
};
