/**
 * Time duration representation with multiple unit support.
 * This module provides a robust way to represent and manipulate time durations
 * using various time units (milliseconds, seconds, minutes, hours, days).
 */

const { Duration } = require('luxon');

/**
 * @typedef {object} TimeDurationData
 * @property {number} milliseconds - The total duration in milliseconds
 */

class TimeDurationClass {
    /** @type {import('luxon').Duration} */
    _luxonDuration;

    /** @type {undefined} */
    __brand = undefined; // nominal typing brand

    /**
     * Creates a new TimeDuration instance.
     * @param {import('luxon').Duration} luxonDuration - The luxon Duration object
     */
    constructor(luxonDuration) {
        if (this.__brand !== undefined) {
            throw new Error("TimeDuration is a nominal type");
        }

        if (!luxonDuration.isValid) {
            throw new InvalidDurationError("Duration must be valid", luxonDuration.invalidExplanation);
        }

        const milliseconds = luxonDuration.toMillis();
        if (milliseconds < 0) {
            throw new InvalidDurationError("Duration must be non-negative", milliseconds);
        }

        this._luxonDuration = luxonDuration;
    }

    /**
     * Gets the duration in milliseconds.
     * @returns {number}
     */
    toMilliseconds() {
        return Math.floor(this._luxonDuration.toMillis());
    }

    /**
     * Gets the duration in seconds.
     * @returns {number}
     */
    toSeconds() {
        return Math.floor(this._luxonDuration.as('seconds'));
    }

    /**
     * Gets the duration in minutes.
     * @returns {number}
     */
    toMinutes() {
        return Math.floor(this._luxonDuration.as('minutes'));
    }

    /**
     * Gets the duration in hours.
     * @returns {number}
     */
    toHours() {
        return Math.floor(this._luxonDuration.as('hours'));
    }

    /**
     * Gets the duration in days.
     * @returns {number}
     */
    toDays() {
        return Math.floor(this._luxonDuration.as('days'));
    }

    /**
     * Returns a human-readable string representation.
     * @returns {string}
     */
    toString() {
        const ms = this.toMilliseconds();
        if (ms < 1000) {
            return `${ms}ms`;
        } else if (ms < 60000) {
            return `${this.toSeconds()}s`;
        } else if (ms < 3600000) {
            return `${this.toMinutes()}m`;
        } else if (ms < 86400000) {
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
        return new TimeDurationClass(this._luxonDuration.plus(other._luxonDuration));
    }

    /**
     * Subtracts another duration from this one.
     * @param {TimeDuration} other
     * @returns {TimeDuration}
     */
    subtract(other) {
        const result = this._luxonDuration.minus(other._luxonDuration);
        if (result.toMillis() < 0) {
            throw new InvalidDurationError("Duration subtraction cannot result in negative duration", result.toMillis());
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
        return new TimeDurationClass(this._luxonDuration.mapUnits(x => x * factor));
    }

    /**
     * Compares this duration with another.
     * @param {TimeDuration} other
     * @returns {number} -1 if this < other, 0 if equal, 1 if this > other
     */
    compare(other) {
        const thisMs = this.toMilliseconds();
        const otherMs = other.toMilliseconds();
        if (thisMs < otherMs) return -1;
        if (thisMs > otherMs) return 1;
        return 0;
    }

    /**
     * Checks if this duration equals another.
     * @param {TimeDuration} other
     * @returns {boolean}
     */
    equals(other) {
        return this.toMilliseconds() === other.toMilliseconds();
    }

    /**
     * Gets the underlying Luxon Duration (for internal use only).
     * @returns {import('luxon').Duration}
     */
    get milliseconds() {
        // Legacy compatibility property
        return this.toMilliseconds();
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
