/**
 * Datetime capability for retrieving the current timestamp.
 * @typedef {object} Datetime
 * @property {() => number} now - Returns the current epoch milliseconds.
 */

function now() {
    return Date.now();
}

/**
 * @returns {Datetime}
 */
function make() {
    return { now };
}

module.exports = { make };
