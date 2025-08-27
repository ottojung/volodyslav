// @ts-check
/**
 * @typedef {object & {__brand:'CronExpression'}} CronExpression
 */

/**
 * Cron expression (nominal type).
 */
class CronExpressionClass {
    /** @type {string} */
    original;
    
    /** @type {number[]} */
    minute;
    
    /** @type {number[]} */
    hour;
    
    /** @type {number[]} */
    day;
    
    /** @type {number[]} */
    month;
    
    /** @type {number[]} */
    weekday;

    /** @type {undefined} */
    __brand = undefined; // nominal typing brand

    /**
     * Creates a new CronExpression instance.
     * @param {string} original - Original cron string
     * @param {number[]} minute - Minute values (0-59)
     * @param {number[]} hour - Hour values (0-23)
     * @param {number[]} day - Day values (1-31)
     * @param {number[]} month - Month values (1-12)
     * @param {number[]} weekday - Weekday values (0-6, 0=Sunday)
     */
    constructor(original, minute, hour, day, month, weekday) {
        if (this.__brand !== undefined) {
            throw new Error("CronExpression is a nominal type");
        }

        this.original = original;
        this.minute = minute;
        this.hour = hour;
        this.day = day;
        this.month = month;
        this.weekday = weekday;
    }

    /**
     * Get the next execution time after the given instant.
     * @param {import('../instant').InstantMs} now - Current time instant
     * @returns {import('../instant').InstantMs} Next execution time
     */
    nextAfter(now) {
        const { parse } = require('./parse');
        const { calculateNext } = require('./parse');
        return calculateNext(this, now);
    }

    /**
     * Calculate the minimum interval between executions.
     * @returns {import('../time-duration').TimeDuration} Minimum interval
     */
    minInterval() {
        const { calculateMinInterval } = require('./parse');
        return calculateMinInterval(this);
    }

    /**
     * Convert to JSON string representation.
     * @returns {string}
     */
    toJSON() {
        return this.original;
    }
}

/**
 * Create a CronExpression from a cron string.
 * @param {string} str - Cron expression string
 * @returns {CronExpression}
 */
function fromString(str) {
    const { parseExpression } = require('./parse');
    return parseExpression(str);
}

/**
 * Type guard for CronExpression.
 * @param {any} object
 * @returns {object is CronExpression}
 */
function isCronExpression(object) {
    return object instanceof CronExpressionClass;
}

module.exports = {
    fromString,
    isCronExpression,
    CronExpressionClass, // Export class for internal use
};