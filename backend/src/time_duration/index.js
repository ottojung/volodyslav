/**
 * TimeDuration module for time duration representation and manipulation.
 * Follows the project's encapsulation pattern where only specific functions are exported.
 */

const {
    fromMilliseconds,
    fromSeconds,
    fromMinutes,
    fromHours,
    fromDays,
    zero,
    COMMON,
    fromDifference,
} = require("./factory");

const {
    isTimeDuration,
    isInvalidDurationError
} = require("./structure");

const {
    sleep,
    timeout,
    withTimeout,
    min,
    max,
} = require("./utils");

/**
 * @typedef {import('./structure').TimeDuration} TimeDuration
 */

module.exports = {
    // Factory functions
    fromMilliseconds,
    fromSeconds,
    fromMinutes,
    fromHours,
    fromDays,
    zero,
    COMMON,
    fromDifference,

    // Type guards
    isTimeDuration,
    isInvalidDurationError,

    // Utilities
    sleep,
    timeout,
    withTimeout,
    min,
    max,
};
