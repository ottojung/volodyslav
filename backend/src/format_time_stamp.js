/**
 * This module provides a function to format a timestamp from a filename
 * into a Date object. The filename is expected to start with a timestamp
 * in the format YYYYMMDDThhmmssZ followed by a dot and an extension.
 */

const datetime = require("./datetime");

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
 * @param {import('./datetime').Datetime} [dt]
 * @returns {import('./datetime').DateTime}
*/
function formatFileTimestamp(filename, dt = datetime.make()) {
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
    const dateObject = formatTimeStamp(basic, dt);

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
 * @param {import('./datetime').Datetime} dt
 * @returns {import('./datetime').DateTime | undefined}
*/
function formatTimeStamp(basic, dt) {
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
    const d = dt.fromISOString(isoUTC);
    if (
        !match ||
        isNaN(dt.toEpochMs(d)) ||
        dt.toNativeDate(d).getUTCFullYear() !== Number(match[1]) ||
        dt.toNativeDate(d).getUTCMonth() + 1 !== Number(match[2]) ||
        dt.toNativeDate(d).getUTCDate() !== Number(match[3]) ||
        dt.toNativeDate(d).getUTCHours() !== Number(match[4]) ||
        dt.toNativeDate(d).getUTCMinutes() !== Number(match[5]) ||
        dt.toNativeDate(d).getUTCSeconds() !== Number(match[6])
    ) {
        return undefined;
    }

    return d;
}

module.exports = {
    formatFileTimestamp,
    isFilenameDoesNotEncodeDate,
};
