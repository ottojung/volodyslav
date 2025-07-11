/**
 * Utility functions for working with TimeDuration instances.
 */

/**
 * Sleeps for the specified duration.
 * @param {import('./structure').TimeDuration} duration - How long to sleep
 * @returns {Promise<void>}
 */
function sleep(duration) {
    return new Promise(resolve => {
        setTimeout(resolve, duration.toMilliseconds());
    });
}

/**
 * Creates a timeout promise that rejects after the specified duration.
 * @param {import('./structure').TimeDuration} duration - How long to wait before timeout
 * @param {string} [message] - Optional timeout message
 * @returns {Promise<never>}
 */
function timeout(duration, message = "Operation timed out") {
    return new Promise((_, reject) => {
        setTimeout(() => {
            reject(new Error(message));
        }, duration.toMilliseconds());
    });
}

/**
 * Races a promise against a timeout.
 * @template T
 * @param {Promise<T>} promise - The promise to race
 * @param {import('./structure').TimeDuration} duration - Timeout duration
 * @param {string} [message] - Optional timeout message
 * @returns {Promise<T>}
 */
function withTimeout(promise, duration, message) {
    return Promise.race([
        promise,
        timeout(duration, message)
    ]);
}

/**
 * Returns the minimum of multiple durations.
 * @param {import('./structure').TimeDuration} first - First duration (required)
 * @param {...import('./structure').TimeDuration} rest - Additional durations
 * @returns {import('./structure').TimeDuration}
 */
function min(first, ...rest) {
    let minDuration = first;
    for (const duration of rest) {
        if (duration.compare(minDuration) < 0) {
            minDuration = duration;
        }
    }
    return minDuration;
}

/**
 * Returns the maximum of multiple durations.
 * @param {import('./structure').TimeDuration} first - First duration (required)
 * @param {...import('./structure').TimeDuration} rest - Additional durations
 * @returns {import('./structure').TimeDuration}
 */
function max(first, ...rest) {
    let maxDuration = first;
    for (const duration of rest) {
        if (duration.compare(maxDuration) > 0) {
            maxDuration = duration;
        }
    }
    return maxDuration;
}

module.exports = {
    sleep,
    timeout,
    withTimeout,
    min,
    max,
};
