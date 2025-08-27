// @ts-check
/**
 * @typedef {number & {__brand:'DurationMs'}} TimeDuration
 */

/**
 * Time duration in milliseconds (nominal type).
 */
class TimeDurationClass {
    /** @type {number} */
    ms;

    /** @type {undefined} */
    __brand = undefined; // nominal typing brand

    /**
     * Creates a new TimeDuration instance.
     * @param {number} ms - Duration in milliseconds
     */
    constructor(ms) {
        if (this.__brand !== undefined) {
            throw new Error("TimeDuration is a nominal type");
        }

        if (!Number.isInteger(ms) || ms < 0) {
            throw new Error("TimeDuration must be a non-negative integer in milliseconds");
        }

        this.ms = ms;
    }

    /**
     * Get the duration in milliseconds.
     * @returns {number}
     */
    toMs() {
        return this.ms;
    }

    /**
     * Get the duration in milliseconds (alias for compatibility).
     * @returns {number}
     */
    toMilliseconds() {
        return this.ms;
    }
}

/**
 * Create a TimeDuration from milliseconds.
 * @param {number} ms - Duration in milliseconds
 * @returns {TimeDuration}
 */
function fromMs(ms) {
    return /** @type {TimeDuration} */ (new TimeDurationClass(ms));
}

/**
 * Create a TimeDuration from minutes.
 * @param {number} minutes - Duration in minutes
 * @returns {TimeDuration}
 */
function fromMinutes(minutes) {
    if (!Number.isFinite(minutes) || minutes < 0) {
        throw new Error("Minutes must be a non-negative finite number");
    }
    return fromMs(Math.floor(minutes * 60 * 1000));
}

/**
 * Get the duration in milliseconds.
 * @param {TimeDuration} duration
 * @returns {number}
 */
function toMs(duration) {
    return duration.ms;
}

/**
 * Add a TimeDuration to an InstantMs.
 * @param {import('../instant').InstantMs} instant
 * @param {TimeDuration} duration
 * @returns {import('../instant').InstantMs}
 */
function addTo(instant, duration) {
    const { fromEpochMs } = require('../instant');
    return fromEpochMs(instant.epochMs + duration.ms);
}

/**
 * Type guard for TimeDuration.
 * @param {any} object
 * @returns {object is TimeDuration}
 */
function isTimeDuration(object) {
    return object instanceof TimeDurationClass;
}

module.exports = {
    fromMs,
    fromMinutes,
    toMs,
    addTo,
    isTimeDuration,
};