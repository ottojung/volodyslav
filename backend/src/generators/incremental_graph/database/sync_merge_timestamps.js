/**
 * Compare two ISO-8601 date strings.
 * Returns negative if a < b, 0 if equal, positive if a > b.
 * `undefined` is treated as the oldest possible value (before any real timestamp).
 *
 * ISO 8601 UTC timestamps (ending in 'Z') are lexicographically ordered,
 * so plain string comparison produces the correct temporal ordering.
 *
 * @param {string | undefined} a
 * @param {string | undefined} b
 * @returns {number}
 */
function compareIsoTimestamps(a, b) {
    if (a === undefined && b === undefined) return 0;
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
}

module.exports = { compareIsoTimestamps };
