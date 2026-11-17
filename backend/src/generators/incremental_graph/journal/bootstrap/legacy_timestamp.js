/**
 * Convert an existing pre-Journal timestamp, without mutating the legacy
 * replica. Older DateTime.toISOString() kept the instant's numeric timezone
 * offset; Journal value records require the equivalent canonical UTC instant.
 *
 * The conversion is pure and accepts only exactly representable milliseconds
 * with an explicit zone. It never guesses a timezone or rounds submilliseconds.
 */
const { fromISOString } = require("../../../../datetime");
const { canonicalJournalTimestamp } = require("../canonical_timestamp");
const { isCanonicalTimestamp } = require("../record_fields");

const EXPLICIT_MILLISECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * @param {unknown} persisted
 * @returns {string | undefined} Canonical Journal instant, or unsupported.
 */
function canonicalLegacyTimestamp(persisted) {
    if (isCanonicalTimestamp(persisted)) return persisted;
    if (typeof persisted !== "string" || !EXPLICIT_MILLISECOND.test(persisted)) return undefined;
    const parsed = fromISOString(persisted);
    if (!parsed.isValid) return undefined;
    const roundTrip = parsed.toISOString();
    if (roundTrip !== persisted && !(persisted.endsWith("+00:00") &&
        roundTrip === persisted.slice(0, -6) + "Z")) return undefined;
    const milliseconds = parsed.toMillis();
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) return undefined;
    const canonical = canonicalJournalTimestamp(milliseconds);
    return isCanonicalTimestamp(canonical) ? canonical : undefined;
}

module.exports = { canonicalLegacyTimestamp };
