const { fromLuxon } = require("./structure");
const { DateTime: LuxonDateTime } = require("luxon");

/** @typedef {import('./structure').DateTime} DateTime */

/**
 * Datetime capability for working with dates.
 * @typedef {object} Datetime
 * @property {() => DateTime} now - Returns the current datetime.
 * @property {() => string} timeZone - Returns the current timezone.
 */

function now() {
    return fromLuxon(LuxonDateTime.now());
}

function timeZone() {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * @returns {Datetime}
 */
function make() {
    return {
        now,
        timeZone,
    };
}

module.exports = {
    make,
};
