/**
 * Cron expression data structure.
 */

/**
 * Represents a parsed cron expression with validated fields.
 */
class CronExpressionClass {
    /** @type {undefined} */
    __brand = undefined; // nominal typing brand

    /**
     * @param {number[]} minute
     * @param {number[]} hour
     * @param {number[]} day
     * @param {number[]} month
     * @param {number[]} weekday
     */
    constructor(minute, hour, day, month, weekday) {
        if (this.__brand !== undefined) {
            throw new Error("CronExpression is a nominal type");
        }
        this.minute = minute;
        this.hour = hour;
        this.day = day;
        this.month = month;
        this.weekday = weekday;
    }

    /**
     * @returns {string}
     */
    unparse() {
        return `${this.minute.join(",")} ${this.hour.join(",")} ${this.day.join(",")} ${this.month.join(",")} ${this.weekday.join(",")}`;
    }

    /**
     * @param {unknown} other
     * @returns {boolean}
     */
    equal(other) {
        if (!(other instanceof CronExpressionClass)) {
            return false;
        }

        return (
            this.minute.length === other.minute.length &&
            this.hour.length === other.hour.length &&
            this.day.length === other.day.length &&
            this.month.length === other.month.length &&
            this.weekday.length === other.weekday.length &&
            this.minute.every((v, i) => v === other.minute[i]) &&
            this.hour.every((v, i) => v === other.hour[i]) &&
            this.day.every((v, i) => v === other.day[i]) &&
            this.month.every((v, i) => v === other.month[i]) &&
            this.weekday.every((v, i) => v === other.weekday[i])
        );
    }
}

/**
 * @param {unknown} object
 * @returns {object is CronExpressionClass}
 */
function isCronExpression(object) {
    return object instanceof CronExpressionClass;
}

/**
 * @typedef {CronExpressionClass} CronExpression
 */

module.exports = {
    CronExpressionClass,
    isCronExpression,
};
