// @ts-check
/**
 * CronExpression class definition.
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

    /**
     * Creates a new CronExpression instance.
     * @param {string} original - Original cron string
     * @param {number[]} minute - Minute values (0-59)
     * @param {number[]} hour - Hour values (0-23)
     * @param {number[]} day - Day values (1-31)
     * @param {number[]} month - Month values (1-12)
     * @param {number[]} weekday - Weekday values (0-7, 0 and 7 = Sunday)
     */
    constructor(original, minute, hour, day, month, weekday) {
        this.original = original;
        this.minute = minute;
        this.hour = hour;
        this.day = day;
        this.month = month;
        this.weekday = weekday;
    }

    /**
     * Get the next execution time after the given instant.
     * @param {import('../instant').InstantMs} fromTime - Starting instant
     * @returns {import('../instant').InstantMs} Next execution instant
     */
    nextAfter(fromTime) {
        const { calculateNext } = require('./parse');
        return calculateNext(this, fromTime);
    }

    /**
     * Check if given instant matches this cron expression.
     * @param {import('../instant').InstantMs} instant - Instant to check
     * @returns {boolean} True if instant matches
     */
    matches(instant) {
        const { checkMatch } = require('./parse');
        return checkMatch(this, instant);
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

module.exports = {
    CronExpressionClass,
};