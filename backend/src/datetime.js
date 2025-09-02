const { DateTime: LuxonDateTime } = require("luxon");

/**
 * Datetime capability for working with dates.
 * @typedef {object} Datetime
 * @property {() => DateTime} now - Returns the current datetime.
 */

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
        const iso = this._luxonDateTime.toISO({ format: 'extended', suppressMilliseconds: false });
        if (!iso) {
            throw new Error("Failed to convert DateTime to ISO string");
        }
        return iso.replace('+00:00', 'Z');
    }


}

/**
 * Checks if the given object is a DateTime instance.
 * @param {unknown} object
 * @returns {object is DateTime}
 */
function isDateTime(object) {
    return object instanceof DateTime;
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
 * @returns {Datetime}
 */
function make() {
    return {
        now,
    };
}

module.exports = {
    make,
    DateTime,
    isDateTime,
    fromEpochMs,
    fromISOString,
    toEpochMs,
    toISOString,
};
