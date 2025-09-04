

/** @typedef {import('./structure').DateTime} DateTime */

const { fromLuxon } = require('./structure');
const { DateTime: LuxonDateTime } = require("luxon");

/**
 * @param {string} iso
 * @returns {DateTime}
 */
function fromISOString(iso) {
    return fromLuxon(LuxonDateTime.fromISO(iso));
}

/**
 * @param {DateTime} dt
 * @returns {string}
 */
function toISOString(dt) {
    return dt.toISOString();
}

/**
 * Gets the modification time of a file from its stats.
 * @param {import('fs').Stats} stats - The file stats object.
 * @returns {DateTime} - The modification time as a DateTime object.
 */
function mtime(stats) {
    return fromLuxon(LuxonDateTime.fromJSDate(stats.mtime));
}

module.exports = {    
    fromISOString,
    toISOString,
    mtime,
};
