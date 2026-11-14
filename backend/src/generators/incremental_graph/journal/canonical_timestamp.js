/**
 * Canonical UTC timestamps for Journal records only. The shared DateTime
 * abstraction preserves its timezone and does not perform this conversion.
 */
const { DateTime: LuxonDateTime } = require("luxon");

/**
 * @param {number} milliseconds - Instant measured from the Unix epoch.
 * @returns {string} Canonical whole-millisecond UTC ISO representation.
 */
function canonicalJournalTimestamp(milliseconds) {
    const iso = LuxonDateTime.fromMillis(milliseconds, { zone: "UTC" }).toISO({
        suppressMilliseconds: false,
    });
    if (iso === null) {
        throw new Error("Cannot serialize a Journal timestamp from invalid milliseconds");
    }
    return iso;
}

module.exports = {
    canonicalJournalTimestamp,
};
