/**
 * Field-level validation shared by the record constructors and the current
 * format codec.
 *
 * A record is valid under the current representation when every one of these
 * checks accepts it. The constructors apply them once, at construction; the
 * codec applies them to persisted input, which it has not constructed yet.
 */

const { isValidationBasisEntry } = require("./basis");
const { makeJournalRecordValidationError } = require("./errors");
const {
    isJournalRecordId,
    parseJournalRecordId,
    TIMESTAMP_PATTERN,
} = require("./types");
const { nodeKeyToCanonicalString } = require("./basis");

/** @typedef {import('./errors').AnyJournalError} JournalError */
/** @typedef {import('./types').JournalRecordId} JournalRecordId */

/**
 * A JSON object at the untrusted input boundary. This is a parse predicate, not
 * a guard for a nominal type.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A canonical whole-millisecond instant. The two persisted value timestamps are
 * physical data with no ordering invariant, so a skewed occurrence is valid.
 * @param {unknown} value
 * @returns {value is string}
 */
function isCanonicalTimestamp(value) {
    return typeof value === "string" && TIMESTAMP_PATTERN.test(value);
}

/**
 * Resolve one member of a closed enumeration, so a record body is only built
 * from a value the current format defines.
 * @param {string} label
 * @param {ReadonlyArray<string>} allowed
 * @param {unknown} value
 * @returns {{ok: true, value: string} | {ok: false, error: JournalError}}
 */
function readEnumMember(label, allowed, value) {
    if (typeof value !== "string" || !allowed.includes(value)) {
        return {
            ok: false,
            error: makeJournalRecordValidationError(
                "reason must be one of " + allowed.join(", ") + ", got " + JSON.stringify(value),
                label
            ),
        };
    }
    return { ok: true, value };
}

/**
 * The current format requires a value payload to be a JSON object. Which
 * concrete `ComputedValue` member it is belongs to the graph scheme that
 * authored the value, so the record layer marks the boundary here the same way
 * the existing NodeIdentifier cast does, and carries the payload unchanged.
 * @param {unknown} value
 * @returns {value is ComputedValue}
 */
function isComputedValue(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A basis has at most one entry for each semantic input NodeKey and is stored
 * in canonical persisted NodeKeyString order.
 * @param {unknown} basis
 * @param {string} label
 * @returns {JournalError | undefined}
 */
function invalidBasisDetail(basis, label) {
    if (!Array.isArray(basis)) {
        return makeJournalRecordValidationError("validation basis must be an array", label);
    }
    /** @type {Set<string>} */
    const seen = new Set();
    /** @type {string | undefined} */
    let previous;
    for (const entry of basis) {
        if (!isValidationBasisEntry(entry)) {
            return makeJournalRecordValidationError("validation basis entry is malformed", label);
        }
        const inputString = nodeKeyToCanonicalString(entry.input);
        if (seen.has(inputString)) {
            return makeJournalRecordValidationError(
                "validation basis names input " + inputString + " more than once",
                label
            );
        }
        if (previous !== undefined && previous >= inputString) {
            return makeJournalRecordValidationError(
                "validation basis is not in canonical NodeKey order at " + inputString,
                label
            );
        }
        seen.add(inputString);
        previous = inputString;
    }
    return undefined;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {JournalRecordId | JournalError}
 */
function readRecordId(value, label) {
    if (isJournalRecordId(value)) {
        return value;
    }
    const parsed = parseJournalRecordId(value);
    if (isJournalRecordId(parsed)) {
        return parsed;
    }
    return makeJournalRecordValidationError("record id is missing or malformed", label);
}

/**
 * The exact set of a persisted value's own members, so an unknown field is
 * rejected rather than silently carried into meaning.
 * @param {Record<string, unknown>} value
 * @param {ReadonlyArray<string>} members
 * @param {string} label
 * @returns {JournalError | undefined}
 */
function unexpectedMemberError(value, members, label) {
    for (const key of Object.keys(value)) {
        if (!members.includes(key)) {
            return makeJournalRecordValidationError(
                "unknown record field " + JSON.stringify(key),
                label
            );
        }
    }
    return undefined;
}

/**
 * A persisted NodeIdentifier is a string assembled by the existing
 * fingerprint-plus-index allocation, so this predicate mirrors that cast rather
 * than re-deciding identifier syntax: the Journal record layer carries the
 * identifier unchanged and never mints one.
 * @param {unknown} value
 * @returns {value is NodeIdentifier}
 */
function isNodeIdentifier(value) {
    return typeof value === "string" && value.length > 0;
}

module.exports = {
    invalidBasisDetail,
    isComputedValue,
    readEnumMember,
    isCanonicalTimestamp,
    isNodeIdentifier,
    isPlainRecord,
    readRecordId,
    unexpectedMemberError,
};
