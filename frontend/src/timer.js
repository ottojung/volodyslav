/**
 * Timer capability for browser environments.
 * @typedef {object} Timer
 * @property {(callback: () => void, ms: number) => number} setTimeout - Schedule a callback.
 * @property {(id: number) => void} clearTimeout - Cancel a scheduled callback.
 * @property {(ms: number) => Promise<void>} wait - Wait for the specified milliseconds.
 */

/**
 * @param {() => void} callback
 * @param {number} ms
 * @returns {number}
 */
function setTimeoutWrapper(callback, ms) {
    return window.setTimeout(callback, ms);
}

/**
 * @param {number} id
 */
function clearTimeoutWrapper(id) {
    window.clearTimeout(id);
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function wait(ms) {
    return new Promise((resolve) => setTimeoutWrapper(resolve, ms));
}

export function make() {
    return {
        setTimeout: setTimeoutWrapper,
        clearTimeout: clearTimeoutWrapper,
        wait,
    };
}
