// @ts-check
/**
 * Local-time clock abstraction.
 */

/**
 * Get current time as InstantMs.
 * @returns {import('../types').InstantMs}
 */
function now() {
    const { fromEpochMs } = require('../value-objects/instant');
    return fromEpochMs(Date.now());
}

/**
 * Convert InstantMs to native Date.
 * @param {import('../types').InstantMs} instant
 * @returns {Date}
 */
function toDate(instant) {
    return new Date(instant.epochMs);
}

/**
 * Add TimeDuration to InstantMs.
 * @param {import('../types').InstantMs} instant
 * @param {import('../types').TimeDuration} duration
 * @returns {import('../types').InstantMs}
 */
function add(instant, duration) {
    const { fromEpochMs } = require('../value-objects/instant');
    return fromEpochMs(instant.epochMs + duration.toMs());
}

/**
 * Subtract two instants to get duration.
 * @param {import('../types').InstantMs} later
 * @param {import('../types').InstantMs} earlier
 * @returns {import('../types').TimeDuration}
 */
function subtract(later, earlier) {
    const { fromMs } = require('../value-objects/time-duration');
    return fromMs(later.epochMs - earlier.epochMs);
}

/**
 * Compare two instants.
 * @param {import('../types').InstantMs} a
 * @param {import('../types').InstantMs} b
 * @returns {boolean} True if a is before b
 */
function isBefore(a, b) {
    return a.epochMs < b.epochMs;
}

/**
 * Compare two instants.
 * @param {import('../types').InstantMs} a
 * @param {import('../types').InstantMs} b
 * @returns {boolean} True if a is after b
 */
function isAfter(a, b) {
    return a.epochMs > b.epochMs;
}

module.exports = {
    now,
    toDate,
    add,
    subtract,
    isBefore,
    isAfter,
};