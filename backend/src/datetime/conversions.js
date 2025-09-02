

/** @typedef {import('./structure').DateTime} DateTime */

const { fromLuxon } = require('./structure');
const { DateTime: LuxonDateTime } = require("luxon");

/**
 * @param {number} ms
 * @returns {DateTime}
 */
function fromEpochMs(ms) {
    return fromLuxon(LuxonDateTime.fromMillis(ms));
}

/**
 * @param {string} iso
 * @returns {DateTime}
 */
function fromISOString(iso) {
    return fromLuxon(LuxonDateTime.fromISO(iso));
}

/**
 * @param {DateTime} dt
 * @returns {number}
 */
function toEpochMs(dt) {
    return dt.getTime();
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
    fromEpochMs,
    fromISOString,
    toEpochMs,
    toISOString,
    mtime,
};
