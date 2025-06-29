/**
 * @typedef {ReturnType<typeof make>} Exiter
 */

/**
 * Exits the process with the provided code.
 * @param {number} code
 * @returns {never}
 */
function exit(code) {
    process.exit(code);
}

function make() {
    return { exit };
}

module.exports = { make };
