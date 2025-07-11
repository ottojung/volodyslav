/**
 * Time duration representation with multiple unit support.
 * This module provides a robust way to represent and manipulate time durations
 * using various time units (milliseconds, seconds, minutes, hours, days).
 */

/**
 * @typedef {object} TimeDurationData
 * @property {number} milliseconds - The total duration in milliseconds
 */

class TimeDurationClass {
    /** @type {number} */
    milliseconds;

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

        this.milliseconds = milliseconds;
    }

    /**
     * Gets the duration in milliseconds.
     * @returns {number}
     */
    toMilliseconds() {
        return this.milliseconds;
    }

    /**
     * Gets the duration in seconds.
     * @returns {number}
     */
    toSeconds() {
        return Math.floor(this.milliseconds / 1000);
    }

    /**
     * Gets the duration in minutes.
     * @returns {number}
     */
    toMinutes() {
        return Math.floor(this.milliseconds / (1000 * 60));
    }

    /**
     * Gets the duration in hours.
     * @returns {number}
     */
    toHours() {
        return Math.floor(this.milliseconds / (1000 * 60 * 60));
    }

    /**
     * Gets the duration in days.
     * @returns {number}
     */
    toDays() {
        return Math.floor(this.milliseconds / (1000 * 60 * 60 * 24));
    }

    /**
     * Returns a human-readable string representation.
     * @returns {string}
     */
    toString() {
        if (this.milliseconds < 1000) {
            return `${this.milliseconds}ms`;
        } else if (this.milliseconds < 60000) {
            return `${this.toSeconds()}s`;
        } else if (this.milliseconds < 3600000) {
            return `${this.toMinutes()}m`;
        } else if (this.milliseconds < 86400000) {
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
        return new TimeDurationClass(this.milliseconds + other.milliseconds);
    }

    /**
     * Subtracts another duration from this one.
     * @param {TimeDuration} other
     * @returns {TimeDuration}
     */
    subtract(other) {
        const result = this.milliseconds - other.milliseconds;
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
        return new TimeDurationClass(Math.floor(this.milliseconds * factor));
    }

    /**
     * Compares this duration with another.
     * @param {TimeDuration} other
     * @returns {number} -1 if this < other, 0 if equal, 1 if this > other
     */
    compare(other) {
        if (this.milliseconds < other.milliseconds) return -1;
        if (this.milliseconds > other.milliseconds) return 1;
        return 0;
    }

    /**
     * Checks if this duration equals another.
     * @param {TimeDuration} other
     * @returns {boolean}
     */
    equals(other) {
        return this.milliseconds === other.milliseconds;
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
