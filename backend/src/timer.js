/**
 * Timer capability providing timeout-related functions.
 * @typedef {object} Timer
 * @property {(callback: () => void, ms: number) => NodeJS.Timeout} setTimeout - Schedule a callback.
 * @property {(id: NodeJS.Timeout) => void} clearTimeout - Cancel a scheduled callback.
 * @property {(ms: number) => Promise<void>} wait - Wait for the specified milliseconds.
 */

/**
 * @param {() => void} callback
 * @param {number} ms
 * @returns {NodeJS.Timeout}
 */
function setTimeoutWrapper(callback, ms) {
    return setTimeout(callback, ms);
}

/**
 * @param {NodeJS.Timeout} id
 */
function clearTimeoutWrapper(id) {
    clearTimeout(id);
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function wait(ms) {
    return new Promise((resolve) => setTimeoutWrapper(resolve, ms));
}

/**
 * @returns {Timer}
 */
function make() {
    return {
        setTimeout: setTimeoutWrapper,
        clearTimeout: clearTimeoutWrapper,
        wait,
    };
}

module.exports = { make };
