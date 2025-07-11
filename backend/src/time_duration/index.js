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
    COMMON
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

module.exports = {
    // Factory functions
    fromMilliseconds,
    fromSeconds,
    fromMinutes,
    fromHours,
    fromDays,
    zero,
    COMMON,

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
