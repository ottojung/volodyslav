
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

    /**
     * Get the Luxon weekday number (1=Monday, 7=Sunday).
     * @returns {number} Luxon weekday number
     */
    get luxonWeekday() {
        return this._luxonDateTime.weekday;
    }

    /**
     * Advance this DateTime by the given Duration.
     * @param {import('luxon').Duration} duration - Duration to advance by
     * @returns {DateTime} New DateTime advanced by the duration
     */
    advance(duration) {
        return fromLuxon(this._luxonDateTime.plus(duration));
    }

    /**
     * Go back by the given Duration.
     * @param {import('luxon').Duration} duration - Duration to go back by
     * @returns {DateTime} New DateTime reduced by the duration
     */
    subtract(duration) {
        return fromLuxon(this._luxonDateTime.minus(duration));
    }

    /**
     * Compare this DateTime with another DateTime.
     * @param {DateTime} other - DateTime to compare with
     * @returns {number} -1 if this is before other, 0 if equal, 1 if this is after other
     */
    compare(other) {
        if (this._luxonDateTime < other._luxonDateTime) return -1;
        if (this._luxonDateTime > other._luxonDateTime) return 1;
        return 0;
    }

    /**
     * Check if this DateTime is before another DateTime.
     * @param {DateTime} other - DateTime to compare with
     * @returns {boolean} True if this DateTime is before the other
     */
    isBefore(other) {
        return this._luxonDateTime < other._luxonDateTime;
    }

    /**
     * Check if this DateTime is after another DateTime.
     * @param {DateTime} other - DateTime to compare with
     * @returns {boolean} True if this DateTime is after the other
     */
    isAfter(other) {
        return this._luxonDateTime > other._luxonDateTime;
    }

    /**
     * Check if this DateTime equals another DateTime.
     * @param {DateTime} other - DateTime to compare with
     * @returns {boolean} True if this DateTime equals the other
     */
    equals(other) {
        return this._luxonDateTime.equals(other._luxonDateTime);
    }

    /**
     * Check if this DateTime is before or equal to another DateTime.
     * @param {DateTime} other - DateTime to compare with
     * @returns {boolean} True if this DateTime is before or equal to the other
     */
    isBeforeOrEqual(other) {
        return this.isBefore(other) || this.equals(other);
    }

    /**
     * Check if this DateTime is after or equal to another DateTime.
     * @param {DateTime} other - DateTime to compare with
     * @returns {boolean} True if this DateTime is after or equal to the other
     */
    isAfterOrEqual(other) {
        return this.isAfter(other) || this.equals(other);
    }

    /**
     * Start from the next minute (useful for cron calculations).
     * Sets seconds and milliseconds to 0 and advances by 1 minute.
     * @returns {DateTime} New DateTime at the start of the next minute
     */
    startOfNextMinute() {
        return fromLuxon(
            this._luxonDateTime
                .set({ second: 0, millisecond: 0 })
                .plus({ minutes: 1 })
        );
    }

    /**
     * Get the start of the current minute.
     * Sets seconds and milliseconds to 0.
     * @returns {DateTime} New DateTime at the start of the current minute
     */
    startOfMinute() {
        return fromLuxon(this._luxonDateTime.set({ second: 0, millisecond: 0 }));
    }

    /**
     * Calculate the duration difference between this DateTime and another DateTime.
     * @param {DateTime} otherDateTime - The other DateTime to compare with
     * @returns {import('luxon').Duration} Duration between the two DateTimes
     */
    diff(otherDateTime) {
        return this._luxonDateTime.diff(otherDateTime._luxonDateTime);
    }

    /**
     * Create a new DateTime for performance-critical iteration starting from next minute.
     * This method is specifically designed for high-performance cron calculations.
     * @returns {DateTime} New DateTime at the start of the next minute for iteration
     */
    startOfNextMinuteForIteration() {
        const nextMinuteLuxon = this._luxonDateTime
            .set({ second: 0, millisecond: 0 })
            .plus({ minutes: 1 });
        return fromLuxon(nextMinuteLuxon);
    }

    /**
     * Check if this DateTime represents a valid date and time.
     * @returns {boolean} True if this DateTime is valid
     */
    get isValid() {
        return this._luxonDateTime.isValid;
    }
}

/** @typedef {DateTimeClass} DateTime */

/**
 * Forward declaration for fromLuxon function.
 * @param {import('luxon').DateTime} luxonDateTime
 * @returns {DateTime}
 */
function fromLuxon(luxonDateTime) {
    return new DateTimeClass(luxonDateTime);
}

/**
 * Checks if the given object is a DateTime instance.
 * @param {unknown} object
 * @returns {object is DateTime}
 */
function isDateTime(object) {
    return object instanceof DateTimeClass;
}

module.exports = {
    fromLuxon,
    isDateTime,
};
