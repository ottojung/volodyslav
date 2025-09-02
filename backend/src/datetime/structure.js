
const { luxonWeekdayToName } = require("./weekday");

class DateTimeClass {
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

    /**
     * @returns {number}
     */
    get year() {
        return this._luxonDateTime.year;
    }

    /**
     * @returns {number}
     */
    get month() {
        return this._luxonDateTime.month;
    }

    /**
     * @returns {number}
     */
    get day() {
        return this._luxonDateTime.day;
    }

    /**
     * @returns {number}
     */
    get hour() {
        return this._luxonDateTime.hour;
    }

    /**
     * @returns {number}
     */
    get minute() {
        return this._luxonDateTime.minute;
    }

    /**
     * @returns {number}
     */
    get second() {
        return this._luxonDateTime.second;
    }

    /**
     * @returns {import('./weekday').WeekdayName}
     */
    get weekday() {
        return luxonWeekdayToName(this._luxonDateTime.weekday);
    }
}

/** @typedef {DateTimeClass} DateTime */

/**
 * Checks if the given object is a DateTime instance.
 * @param {unknown} object
 * @returns {object is DateTime}
 */
function isDateTime(object) {
    return object instanceof DateTimeClass;
}

/**
 * The main constructor.
 * @param {import('luxon').DateTime} luxonDateTime
 * @returns {DateTime}
 */
function fromLuxon(luxonDateTime) {
    return new DateTimeClass(luxonDateTime);
}

module.exports = {
    fromLuxon,
    isDateTime,
};
