/**
 * Time duration representation with multiple unit support.
 * This module provides a robust way to represent and manipulate time durations
 * using various time units (milliseconds, seconds, minutes, hours, days).
 * Now backed by Luxon Duration for improved functionality.
 */

const { Duration } = require('luxon');

/**
 * @typedef {object} TimeDurationData
 * @property {number} milliseconds - The total duration in milliseconds
 */

class TimeDurationClass {
    /** @type {import('luxon').Duration} */
    #luxonDuration;

    /** @type {undefined} */
    __brand = undefined; // nominal typing brand

    /**
     * Creates a new TimeDuration instance.
     * @param {number} milliseconds - The duration in milliseconds
     */
    constructor(milliseconds) {
        if (this.__brand !== undefined) {
            throw new Error("TimeDuration is a nominal type");
        }

        if (!Number.isInteger(milliseconds) || milliseconds < 0) {
            throw new InvalidDurationError("Duration must be a non-negative integer in milliseconds", milliseconds);
        }

        this.#luxonDuration = Duration.fromMillis(milliseconds);
    }

    /**
     * Gets the duration in milliseconds.
     * @returns {number}
     */
    toMilliseconds() {
        return this.#luxonDuration.toMillis();
    }

    /**
     * Gets the duration in seconds.
     * @returns {number}
     */
    toSeconds() {
        return Math.floor(this.#luxonDuration.as('seconds'));
    }

    /**
     * Gets the duration in minutes.
     * @returns {number}
     */
    toMinutes() {
        return Math.floor(this.#luxonDuration.as('minutes'));
    }

    /**
     * Gets the duration in hours.
     * @returns {number}
     */
    toHours() {
        return Math.floor(this.#luxonDuration.as('hours'));
    }

    /**
     * Gets the duration in days.
     * @returns {number}
     */
    toDays() {
        return Math.floor(this.#luxonDuration.as('days'));
    }

    /**
     * Returns a human-readable string representation.
     * @returns {string}
     */
    toString() {
        const milliseconds = this.#luxonDuration.toMillis();
        if (milliseconds < 1000) {
            return `${milliseconds}ms`;
        } else if (milliseconds < 60000) {
            return `${this.toSeconds()}s`;
        } else if (milliseconds < 3600000) {
            return `${this.toMinutes()}m`;
        } else if (milliseconds < 86400000) {
            return `${this.toHours()}h`;
        } else {
            return `${this.toDays()}d`;
        }
    }

    /**
     * Adds another duration to this one.
     * @param {TimeDuration} other
     * @returns {TimeDuration}
     */
    add(other) {
        const resultDuration = this.#luxonDuration.plus(other.#luxonDuration);
        return new TimeDurationClass(resultDuration.toMillis());
    }

    /**
     * Subtracts another duration from this one.
     * @param {TimeDuration} other
     * @returns {TimeDuration}
     */
    subtract(other) {
        const resultDuration = this.#luxonDuration.minus(other.#luxonDuration);
        const result = resultDuration.toMillis();
        if (result < 0) {
            throw new InvalidDurationError("Duration subtraction cannot result in negative duration", result);
        }
        return new TimeDurationClass(result);
    }

    /**
     * Multiplies the duration by a factor.
     * @param {number} factor
     * @returns {TimeDuration}
     */
    multiply(factor) {
        if (!Number.isFinite(factor) || factor < 0) {
            throw new InvalidDurationError("Multiplication factor must be a non-negative finite number", factor);
        }
        const resultMillis = Math.floor(this.#luxonDuration.toMillis() * factor);
        return new TimeDurationClass(resultMillis);
    }

    /**
     * Compares this duration with another.
     * @param {TimeDuration} other
     * @returns {number} -1 if this < other, 0 if equal, 1 if this > other
     */
    compare(other) {
        const thisMillis = this.#luxonDuration.toMillis();
        const otherMillis = other.#luxonDuration.toMillis();
        if (thisMillis < otherMillis) return -1;
        if (thisMillis > otherMillis) return 1;
        return 0;
    }

    /**
     * Checks if this duration equals another.
     * @param {TimeDuration} other
     * @returns {boolean}
     */
    equals(other) {
        return this.#luxonDuration.equals(other.#luxonDuration);
    }
}

/** @typedef {TimeDurationClass} TimeDuration */

/**
 * Error thrown when invalid duration parameters are provided.
 */
class InvalidDurationError extends Error {
    /** @type {unknown} */
    value;

    /**
     * @param {string} message
     * @param {unknown} value
     */
    constructor(message, value) {
        super(message);
        this.name = "InvalidDurationError";
        this.value = value;
    }
}

/**
 * Type guard for InvalidDurationError.
 * @param {unknown} object
 * @returns {object is InvalidDurationError}
 */
function isInvalidDurationError(object) {
    return object instanceof InvalidDurationError;
}

/**
 * Type guard for TimeDuration.
 * @param {unknown} object
 * @returns {object is TimeDuration}
 */
function isTimeDuration(object) {
    return object instanceof TimeDurationClass;
}

module.exports = {
    TimeDurationClass,
    InvalidDurationError,
    isTimeDuration,
    isInvalidDurationError,
};
