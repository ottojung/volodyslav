/**
 * Provides a capability for exiting the process.
 */

/**
 * @typedef {object} Exiter
 * @property {(code: number) => void} exit
 */

/**
 * Exit the process with the given code.
 * @param {number} code - Exit code.
 */
function exit(code) {
    process.exit(code);
}

function make() {
    return { exit };
}

module.exports = { make };
