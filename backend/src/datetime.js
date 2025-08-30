/**
 * Datetime capability for working with dates.
 * @typedef {object} Datetime
 * @property {() => DateTime} now - Returns the current datetime.
 * @property {(ms: number) => DateTime} fromEpochMs - Creates a DateTime from milliseconds.
 * @property {(iso: string) => DateTime} fromISOString - Creates a DateTime from ISO string.
 * @property {(dt: DateTime) => number} toEpochMs - Converts DateTime to epoch milliseconds.
 * @property {(dt: DateTime) => string} toISOString - Converts DateTime to ISO string.
 * @property {(dt: DateTime) => Date} toNativeDate - Converts DateTime to native Date.
 */

const { DateTime: LuxonDateTime } = require('luxon');

class DateTime {
    /** @type {undefined} */
    __brand = undefined;

    /**
     * @param {import('luxon').DateTime} luxonDateTime
     */
    constructor(luxonDateTime) {
        this._luxonDateTime = luxonDateTime;
        if (this.__brand !== undefined) {
            throw new Error("DateTime is nominal");
        }
    }

    /**
     * @returns {number}
     */
    getTime() {
        return this._luxonDateTime.toMillis();
    }

    /**
     * @returns {string}
     */
    toISOString() {
        const iso = this._luxonDateTime.toISO();
        if (iso === null) {
            throw new Error("Invalid DateTime: cannot convert to ISO string");
        }
        // Convert +00:00 to Z for backward compatibility with native Date
        return iso.replace('+00:00', 'Z');
    }

    /**
     * @returns {Date}
     */
    toDate() {
        return this._luxonDateTime.toJSDate();
    }
}

function now() {
    return new DateTime(LuxonDateTime.now());
}

/**
 * @param {number} ms
 * @returns {DateTime}
 */
function fromEpochMs(ms) {
    return new DateTime(LuxonDateTime.fromMillis(ms));
}

/**
 * @param {string} iso
 * @returns {DateTime}
 */
function fromISOString(iso) {
    return new DateTime(LuxonDateTime.fromISO(iso));
}

/**
 * @param {DateTime} dt
 * @returns {number}
 */
function toEpochMs(dt) {
    return dt.getTime();
}

/**
 * @param {DateTime} dt
 * @returns {string}
 */
function toISOString(dt) {
    return dt.toISOString();
}

/**
 * @param {DateTime} dt
 * @returns {Date}
 */
function toNativeDate(dt) {
    return dt.toDate();
}

/**
 * @returns {Datetime}
 */
function make() {
    return {
        now,
        fromEpochMs,
        fromISOString,
        toEpochMs,
        toISOString,
        toNativeDate,
    };
}

module.exports = {
    make,
    DateTime,
};
