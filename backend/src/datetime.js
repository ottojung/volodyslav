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

class DateTime {
    /** @type {undefined} */
    __brand = undefined;

    /**
     * @param {Date} date
     */
    constructor(date) {
        this._date = date;
        if (this.__brand !== undefined) {
            throw new Error("DateTime is nominal");
        }
    }

    /**
     * @returns {number}
     */
    getTime() {
        return this._date.getTime();
    }

    /**
     * @returns {string}
     */
    toISOString() {
        return this._date.toISOString();
    }

    /**
     * @returns {Date}
     */
    toDate() {
        return new Date(this._date.getTime());
    }
}

function now() {
    return new DateTime(new Date());
}

/**
 * @param {number} ms
 * @returns {DateTime}
 */
function fromEpochMs(ms) {
    return new DateTime(new Date(ms));
}

/**
 * @param {string} iso
 * @returns {DateTime}
 */
function fromISOString(iso) {
    return new DateTime(new Date(iso));
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
