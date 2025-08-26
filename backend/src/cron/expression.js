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
