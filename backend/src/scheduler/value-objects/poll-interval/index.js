// @ts-check
/**
 * @typedef {number & {__brand:'PollIntervalMs'}} PollIntervalMs
 */

/**
 * Poll interval in milliseconds (nominal type).
 */
class PollIntervalClass {
    /** @type {number} */
    ms;

    /** @type {undefined} */
    __brand = undefined; // nominal typing brand

    /**
     * Creates a new PollInterval instance.
     * @param {number} ms - Poll interval in milliseconds
     */
    constructor(ms) {
        if (this.__brand !== undefined) {
            throw new Error("PollInterval is a nominal type");
        }

        if (!Number.isInteger(ms) || ms <= 0) {
            throw new Error("PollInterval must be a positive integer in milliseconds");
        }

        this.ms = ms;
    }

    /**
     * Get the poll interval in milliseconds.
     * @returns {number}
     */
    toMs() {
        return this.ms;
    }
}

/**
 * Create a PollInterval from milliseconds.
 * @param {number} ms - Poll interval in milliseconds
 * @returns {PollIntervalMs}
 */
function fromMs(ms) {
    return /** @type {PollIntervalMs} */ (new PollIntervalClass(ms));
}

/**
 * Assert that a cron's minimum interval is not faster than the poll interval.
 * @param {import('../time-duration').TimeDuration} cronMinInterval
 * @param {PollIntervalMs} pollInterval
 * @throws {Error} if cron is faster than poll interval
 */
function assertCronNotFaster(cronMinInterval, pollInterval) {
    if (cronMinInterval.toMilliseconds() < pollInterval.ms) {
        throw new Error(`Cron minimum interval (${cronMinInterval.toMilliseconds()}ms) is faster than poll interval (${pollInterval.ms}ms)`);
    }
}

/**
 * Type guard for PollInterval.
 * @param {any} object
 * @returns {object is PollIntervalMs}
 */
function isPollInterval(object) {
    return object instanceof PollIntervalClass;
}

module.exports = {
    fromMs,
    assertCronNotFaster,
    isPollInterval,
};