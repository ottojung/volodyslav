const { fromLuxon } = require("./structure");
const { DateTime: LuxonDateTime } = require("luxon");

/** @typedef {import('./structure').DateTime} DateTime */

/**
 * Datetime capability for working with dates.
 * @typedef {object} Datetime
 * @property {() => DateTime} now - Returns the current datetime.
 */

function now() {
    return fromLuxon(LuxonDateTime.now());
}

/**
 * @returns {Datetime}
 */
function make() {
    return {
        now,
    };
}

module.exports = {
    make,
};
