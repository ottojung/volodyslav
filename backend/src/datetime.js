const dateValue = require("./date_value");

/**
 * Datetime capability for retrieving the current timestamp and constructing
 * date objects.
 *
 * @typedef {object} Datetime
 * @property {() => number} now - Returns the current epoch milliseconds.
 * @property {(timestamp: number) => dateValue.DateValue} fromTimestamp -
 *  Creates a date from an epoch timestamp.
 * @property {(isoString: string) => dateValue.DateValue} fromString -
 *  Creates a date from an ISO string.
 * @property {(object: unknown) => object is dateValue.DateValue} isDate -
 *  Type guard for DateValue.
 */

function now() {
    return Date.now();
}

/**
 * @param {number} timestamp
 * @returns {dateValue.DateValue}
 */
function fromTimestamp(timestamp) {
    return dateValue.fromTimestamp(timestamp);
}

/**
 * @param {string} isoString
 * @returns {dateValue.DateValue}
 */
function fromString(isoString) {
    return dateValue.fromISOString(isoString);
}

/**
 * @returns {Datetime}
 */
function make() {
    return {
        now,
        fromTimestamp,
        fromString,
        isDate: dateValue.isDateValue,
    };
}

module.exports = { make };
