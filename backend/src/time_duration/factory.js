/**
 * Factory functions for creating TimeDuration instances from various units.
 * This provides a clean API for creating duration objects without direct constructor access.
 */

const { TimeDurationClass, InvalidDurationError } = require("./structure");

/**
 * Creates a TimeDuration from milliseconds.
 * @param {number} value - Duration in milliseconds
 * @returns {import('./structure').TimeDuration}
 * @throws {InvalidDurationError} When value is not a valid duration
 */
function fromMilliseconds(value) {
    return new TimeDurationClass(value);
}

/**
 * Creates a TimeDuration from seconds.
 * @param {number} value - Duration in seconds
 * @returns {import('./structure').TimeDuration}
 * @throws {InvalidDurationError} When value is not a valid duration
 */
function fromSeconds(value) {
    if (!Number.isFinite(value) || value < 0) {
        throw new InvalidDurationError("Seconds must be a non-negative finite number", value);
    }
    return new TimeDurationClass(Math.floor(value * 1000));
}

/**
 * Creates a TimeDuration from minutes.
 * @param {number} value - Duration in minutes
 * @returns {import('./structure').TimeDuration}
 * @throws {InvalidDurationError} When value is not a valid duration
 */
function fromMinutes(value) {
    if (!Number.isFinite(value) || value < 0) {
        throw new InvalidDurationError("Minutes must be a non-negative finite number", value);
    }
    return new TimeDurationClass(Math.floor(value * 60 * 1000));
}

/**
 * Creates a TimeDuration from hours.
 * @param {number} value - Duration in hours
 * @returns {import('./structure').TimeDuration}
 * @throws {InvalidDurationError} When value is not a valid duration
 */
function fromHours(value) {
    if (!Number.isFinite(value) || value < 0) {
        throw new InvalidDurationError("Hours must be a non-negative finite number", value);
    }
    return new TimeDurationClass(Math.floor(value * 60 * 60 * 1000));
}

/**
 * Creates a TimeDuration from days.
 * @param {number} value - Duration in days
 * @returns {import('./structure').TimeDuration}
 * @throws {InvalidDurationError} When value is not a valid duration
 */
function fromDays(value) {
    if (!Number.isFinite(value) || value < 0) {
        throw new InvalidDurationError("Days must be a non-negative finite number", value);
    }
    return new TimeDurationClass(Math.floor(value * 24 * 60 * 60 * 1000));
}

/**
 * Creates a zero duration (0 milliseconds).
 * @returns {import('./structure').TimeDuration}
 */
function zero() {
    return new TimeDurationClass(0);
}

/**
 * Creates common durations for convenience.
 */
const COMMON = {
    /** @type {import('./structure').TimeDuration} */
    ONE_SECOND: fromSeconds(1),
    /** @type {import('./structure').TimeDuration} */
    FIVE_SECONDS: fromSeconds(5),
    /** @type {import('./structure').TimeDuration} */
    TEN_SECONDS: fromSeconds(10),
    /** @type {import('./structure').TimeDuration} */
    THIRTY_SECONDS: fromSeconds(30),
    /** @type {import('./structure').TimeDuration} */
    ONE_MINUTE: fromMinutes(1),
    /** @type {import('./structure').TimeDuration} */
    FIVE_MINUTES: fromMinutes(5),
    /** @type {import('./structure').TimeDuration} */
    TEN_MINUTES: fromMinutes(10),
    /** @type {import('./structure').TimeDuration} */
    THIRTY_MINUTES: fromMinutes(30),
    /** @type {import('./structure').TimeDuration} */
    ONE_HOUR: fromHours(1),
    /** @type {import('./structure').TimeDuration} */
    ONE_DAY: fromDays(1),
};

/**
 * @typedef {import('../datetime').DateTime} DateTime
 */

/**
 * @param {DateTime} later
 * @param {DateTime} earlier
 */
function fromDifference(later, earlier) {
    const diff = later.getTime() - earlier.getTime();
    return fromMilliseconds(diff);
}

module.exports = {
    fromMilliseconds,
    fromSeconds,
    fromMinutes,
    fromHours,
    fromDays,
    zero,
    COMMON,
    fromDifference,
};
