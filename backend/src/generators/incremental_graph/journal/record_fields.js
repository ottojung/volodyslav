/**
 * Field-level validation shared by the record constructors and the current
 * format codec.
 *
 * A record is valid under the current representation when every one of these
 * checks accepts it. The constructors apply them once, at construction; the
 * codec applies them to persisted input, which it has not constructed yet.
 */

const { isValidationBasisEntry } = require("./basis");
const { deepFrozenCopy } = require("./immutable");
const { COMPUTED_VALUE_TYPE_TAGS, isValidFingerprint } = require("../database");
const { makeJournalRecordValidationError } = require("./errors");
const {
    isJournalRecordId,
    journalAuthorToString,
    journalSequenceToString,
    parseJournalRecordId,
    TIMESTAMP_PATTERN,
} = require("./types");
const { nodeKeyToCanonicalString } = require("./basis");

/** @typedef {import('./errors').AnyJournalError} JournalError */
/** @typedef {import('../database/types').ComputedValue} ComputedValue */
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
 * The current format requires a value payload to be a JSON object which belongs
 * to the current `ComputedValue` union.
 *
 * Which concrete union member a payload is belongs to the graph scheme that
 * authored the value, so this predicate decides exactly what the record layer can
 * decide by itself and no more: the payload is an object, and it carries the
 * `type` discriminant of one current union member. A payload which names no
 * current union member is not a current-version `ComputedValue` at all, so
 * persisted history containing one is rejected instead of being carried forward
 * as a value occurrence with no representation. The inner members of the named
 * variant are the graph scheme's own contract, not this layer's.
 * @param {unknown} value
 * @returns {value is ComputedValue}
 */
function isComputedValue(value) {
    if (!isPlainRecord(value)) {
        return false;
    }
    const tag = value["type"];
    return typeof tag === "string" && COMPUTED_VALUE_TYPE_TAGS.has(tag);
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
 * A persisted NodeIdentifier is exactly what the existing allocation rule
 * produces: a base36 local allocation index, a `-` separator, and the writer's
 * allocation fingerprint.
 *
 * The allocator mints every identifier from those two components, both of which
 * are valid by construction, so the form is a current-format property of the
 * persisted text rather than a re-decided identifier syntax: persisted history
 * which does not have it is not a NodeIdentifier this database ever allocated,
 * and it is rejected instead of being normalised into one. The identifier string
 * itself is unchanged by the record layer, which never mints an identifier.
 * @param {unknown} value
 * @returns {value is NodeIdentifier}
 */
function isNodeIdentifier(value) {
    if (typeof value !== "string") {
        return false;
    }
    const separator = value.indexOf("-");
    if (separator < 1 || separator === value.length - 1) {
        return false;
    }
    const index = value.slice(0, separator);
    if (!/^[0-9a-z]+$/.test(index)) {
        return false;
    }
    return isValidFingerprint(value.slice(separator + 1));
}

/**
 * A payload the record layer owns: a detached, deeply frozen copy, re-accepted as
 * a `ComputedValue` so the copy carries the nominal type without a cast.
 *
 * A record which kept the caller's payload object would let a later mutation of
 * that object change a stored record's canonical meaning, and with it the fork
 * comparison between two records which claim one identity.
 * @param {ComputedValue} payload
 * @returns {ComputedValue}
 */
function ownedComputedValue(payload) {
    const copy = deepFrozenCopy(payload);
    if (!isComputedValue(copy)) {
        throw new Error("a payload did not survive being copied into a record");
    }
    return copy;
}

/**
 * The coordinates of a context, in canonical author order, which is the order
 * the current format persists them in.
 * @param {import('./types').JournalFrontier} context
 * @returns {Array<[string, string]>}
 */
function contextToText(context) {
    /** @type {Array<[string, string]>} */
    const coordinates = [];
    for (const entry of context) {
        coordinates.push([journalAuthorToString(entry[0]), journalSequenceToString(entry[1])]);
    }
    return coordinates.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

module.exports = {
    contextToText,
    invalidBasisDetail,
    isComputedValue,
    readEnumMember,
    isCanonicalTimestamp,
    isNodeIdentifier,
    isPlainRecord,
    ownedComputedValue,
    readRecordId,
    unexpectedMemberError,
};
