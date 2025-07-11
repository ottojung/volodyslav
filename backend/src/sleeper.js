/**
 * Sleeper capability for pausing execution.
 */

/**
 * @typedef {object} Sleeper
 * @property {(ms: number) => Promise<void>} sleep - Pause for the given milliseconds.
 */

/**
 * Pauses execution for the specified milliseconds.
 * @param {number} ms - Milliseconds to sleep.
 * @returns {Promise<void>} Resolves after the delay.
 */
function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function make() {
    return { sleep };
}

module.exports = {
    make,
};
