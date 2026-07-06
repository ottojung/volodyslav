const { DateTime: LuxonDateTime } = require("luxon");

/**
 * Error thrown when a timestamp string cannot be parsed as ISO 8601.
 */
class InvalidIsoTimestampError extends Error {
    /**
     * @param {string} message
     * @param {string} value
     */
    constructor(message, value) {
        super(message);
        this.name = "InvalidIsoTimestampError";
        this.value = value;
    }
}

/**
 * @param {unknown} object
 * @returns {object is InvalidIsoTimestampError}
 */
function isInvalidIsoTimestampError(object) {
    return object instanceof InvalidIsoTimestampError;
}

/**
 * Parse an ISO timestamp string to epoch milliseconds using Luxon.
 * Returns NaN if the string is not a valid ISO timestamp.
 * @param {string} iso
 * @returns {number}
 */
function parseIsoToMillis(iso) {
    const dt = LuxonDateTime.fromISO(iso, { setZone: true });
    if (!dt.isValid) {
        return NaN;
    }
    return dt.toMillis();
}

/**
 * Compare two ISO-8601 date strings.
 * Returns negative if a < b, 0 if equal, positive if a > b.
 * `undefined` is treated as the oldest possible value (before any real timestamp).
 *
 * Timestamps are compared chronologically by converting to epoch millis,
 * so mixed-offset ISO strings (e.g. `-07:00` vs `Z`) compare correctly.
 *
 * @param {string | undefined} a
 * @param {string | undefined} b
 * @returns {number}
 * @throws {InvalidIsoTimestampError} If either string is not a valid ISO timestamp.
 */
function compareIsoTimestamps(a, b) {
    if (a === undefined && b === undefined) return 0;
    if (a === undefined) return -1;
    if (b === undefined) return 1;

    const msA = parseIsoToMillis(a);
    const msB = parseIsoToMillis(b);

    if (Number.isNaN(msA)) {
        throw new InvalidIsoTimestampError(
            `Invalid ISO timestamp string: ${a}`,
            a
        );
    }
    if (Number.isNaN(msB)) {
        throw new InvalidIsoTimestampError(
            `Invalid ISO timestamp string: ${b}`,
            b
        );
    }

    if (msA < msB) return -1;
    if (msA > msB) return 1;
    return 0;
}

module.exports = { compareIsoTimestamps, InvalidIsoTimestampError, isInvalidIsoTimestampError };
