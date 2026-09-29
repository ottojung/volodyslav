/**
 * Journal 3 identities, authority, frontiers and ordering.
 *
 * Every nominal type in this module carries a property, and the comment above
 * it names the functions which introduce values of that type together with the
 * reason those functions establish the property.
 */

const { isValidFingerprint } = require("../database");
const { makeJournalRecordValidationError } = require("./errors");

/** @typedef {import('./errors').AnyJournalError} JournalError */
/** @typedef {import('../database/node_key').NodeKey} NodeKey */
/** @typedef {import('../database/types').ComputedValue} ComputedValue */
/** @typedef {import('../database/types').NodeIdentifier} NodeIdentifier */

const SEQUENCE_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const TIMESTAMP_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
// The record id text is `<DatabaseFingerprint>:<canonical sequence digits>`, so
// the fingerprint alphabet already excludes the separator and the textual form is
// parsed without any lookahead at the boundary between the two coordinates.
const RECORD_ID_PATTERN = /^([a-z]{9,}):([0-9]+)$/;

/**
 * The properties that this class carries are:
 * - `__value` is the canonical decimal representation of a non-negative
 *   arbitrary-precision integer, without leading zeros.
 *
 * The proof of those properties is guaranteed by:
 * - `makeJournalSequence(digits)`: accepts the value only when `digits` matches
 *   `SEQUENCE_PATTERN`, which admits exactly the canonical decimal
 *   representations of non-negative integers.
 * - `parseJournalRecordId(text)`: the captured sequence digits are accepted only
 *   when they match `SEQUENCE_PATTERN`.
 * - `predecessorJournalSequence(sequence)`: returns the decimal borrow
 *   decrement of the canonical digits, which is canonical decimal because the
 *   only borrow-produced leading zero is stripped and zero itself is rejected.
 * - `journalSequenceAtFrontier(frontier, author)`: returns either a stored
 *   canonical sequence or `ZERO_JOURNAL_SEQUENCE`.
 *
 * A `JournalSequence` is never a JavaScript `number`. A sequence coordinate is
 * arbitrary-precision and persisted JSON numbers are doubles, so a `number`
 * would silently lose precision and could alias two coordinates onto one record
 * identity.
 */
class JournalSequenceClass {
    /** @type {string} */
    __value;
    /**
     * @param {string} value
     */
    constructor(value) {
        this.__value = value;
        Object.freeze(this);
    }
}

/** @typedef {JournalSequenceClass} JournalSequence */

/**
 * The zero coordinate. A missing frontier coordinate means zero.
 * @type {JournalSequence}
 */
const ZERO_JOURNAL_SEQUENCE = new JournalSequenceClass("0");

/**
 * @param {unknown} value
 * @returns {value is JournalSequence}
 */
function isJournalSequence(value) {
    return value instanceof JournalSequenceClass;
}

/**
 * @param {string} digits
 * @returns {JournalSequence | JournalError}
 */
function makeJournalSequence(digits) {
    if (typeof digits !== "string" || !SEQUENCE_PATTERN.test(digits)) {
        return makeJournalRecordValidationError(
            "journal sequence must be a canonical decimal integer, got " + JSON.stringify(digits),
            "unknown"
        );
    }
    return new JournalSequenceClass(digits);
}

/**
 * @param {JournalSequence} sequence
 * @returns {string}
 */
function journalSequenceToString(sequence) {
    return sequence.__value;
}

/**
 * Compare two sequence coordinates numerically without converting to `number`.
 * @param {JournalSequence} a
 * @param {JournalSequence} b
 * @returns {number} negative if a < b, 0 if equal, positive if a > b
 */
function compareJournalSequence(a, b) {
    const left = journalSequenceToString(a);
    const right = journalSequenceToString(b);
    if (left.length !== right.length) {
        return left.length - right.length;
    }
    if (left < right) {
        return -1;
    }
    if (left > right) {
        return 1;
    }
    return 0;
}

/**
 * The coordinate immediately before `sequence`.
 *
 * The decrement is decimal borrow on canonical digits, so the result is exact at
 * any width: `9 -> 8`, `10 -> 9`, `100 -> 99`, `1000 -> 999`. It is deliberately
 * not a `number` and not a `BigInt`: a `number` loses precision above 2^53 and
 * `BigInt` is not available at this module's compilation target. Zero has no
 * predecessor, so the predecessor of zero is a validation failure rather than a
 * silent wrap onto a negative or reordered representation.
 * @param {JournalSequence} sequence
 * @returns {JournalSequence | JournalError}
 */
function predecessorJournalSequence(sequence) {
    const canonical = journalSequenceToString(sequence);
    if (canonical === "0") {
        return makeJournalRecordValidationError(
            "journal sequence zero has no predecessor",
            "unknown"
        );
    }
    const digits = canonical.split("");
    /** @type {number} */
    let index = digits.length - 1;
    while (index >= 0) {
        const borrowed = Number(digits[index]) - 1;
        if (borrowed >= 0) {
            digits[index] = String(borrowed);
            break;
        }
        digits[index] = "9";
        index--;
    }
    const decremented = digits.join("").replace(/^0+(?=[0-9])/, "");
    return new JournalSequenceClass(decremented);
}

/**
 * The properties that this class carries are:
 * - `__value` is a database allocation fingerprint, which is therefore a
 *   non-empty lowercase-letter string of at least nine characters and never
 *   contains the record-id separator.
 *
 * The proof of those properties is guaranteed by:
 * - `makeJournalAuthor(name)`: accepts the value only when `isValidFingerprint`
 *   accepts it, which is exactly the persisted `DatabaseFingerprint` contract.
 * - `parseJournalRecordId(text)`: the captured author is passed through
 *   `makeJournalAuthor`.
 *
 * A `JournalAuthor` is the `DatabaseFingerprint` of the writer, as
 * `docs/specs/incremental-graph-journal.md` states. A writer which owns a stream
 * obtains its author from the allocation fingerprint it already persists.
 * Because the fingerprint alphabet excludes `:`, an identity minted here and
 * rendered through `journalRecordIdToString` is always parseable again, and
 * persisted record-id text which is not of this form is rejected instead of being
 * re-split into a different identity.
 */
class JournalAuthorClass {
    /** @type {string} */
    __value;
    /**
     * @param {string} value
     */
    constructor(value) {
        this.__value = value;
        Object.freeze(this);
    }
}

/** @typedef {JournalAuthorClass} JournalAuthor */

/**
 * @param {unknown} value
 * @returns {value is JournalAuthor}
 */
function isJournalAuthor(value) {
    return value instanceof JournalAuthorClass;
}

/**
 * The writer identity of one stream: the writer's persisted database allocation
 * fingerprint.
 * @param {string} name
 * @returns {JournalAuthor | JournalError}
 */
function makeJournalAuthor(name) {
    if (!isValidFingerprint(name)) {
        return makeJournalRecordValidationError(
            "journal author must be a database fingerprint, got " + JSON.stringify(name),
            "unknown"
        );
    }
    return new JournalAuthorClass(name);
}

/**
 * @param {JournalAuthor} author
 * @returns {string}
 */
function journalAuthorToString(author) {
    return author.__value;
}

/**
 * The properties that this class carries are:
 * - `author` is a `JournalAuthor`;
 * - `sequence` is a `JournalSequence` whose canonical decimal representation
 *   is positive.
 *
 * The proof of those properties is guaranteed by:
 * - `makeJournalRecordId(author, sequence)`: rejects arguments which are not a
 *   `JournalAuthor` and a `JournalSequence`, and rejects the zero sequence,
 *   because `sequence >= 1` is a record-identity requirement.
 * - `parseJournalRecordId(text)`: builds the id from a validated author and a
 *   validated sequence, and rejects a zero sequence.
 */
class JournalRecordIdClass {
    /**
     * @param {JournalAuthor} author
     * @param {JournalSequence} sequence
     */
    constructor(author, sequence) {
        this.author = author;
        this.sequence = sequence;
        Object.freeze(this);
    }
}

/** @typedef {JournalRecordIdClass} JournalRecordId */

/**
 * @param {unknown} value
 * @returns {value is JournalRecordId}
 */
function isJournalRecordId(value) {
    return value instanceof JournalRecordIdClass;
}

/**
 * @param {unknown} author
 * @param {unknown} sequence
 * @returns {JournalRecordId | JournalError}
 */
function makeJournalRecordId(author, sequence) {
    if (!isJournalAuthor(author) || !isJournalSequence(sequence)) {
        return makeJournalRecordValidationError(
            "record id requires a journal author and a journal sequence",
            "unknown"
        );
    }
    if (compareJournalSequence(sequence, ZERO_JOURNAL_SEQUENCE) === 0) {
        return makeJournalRecordValidationError(
            "record id sequence must be >= 1",
            journalAuthorToString(author) + ":0"
        );
    }
    return new JournalRecordIdClass(author, sequence);
}

/**
 * @param {JournalRecordId} recordId
 * @returns {string}
 */
function journalRecordIdToString(recordId) {
    return journalAuthorToString(recordId.author) + ":" + journalSequenceToString(recordId.sequence);
}

/**
 * @param {unknown} text
 * @returns {JournalRecordId | JournalError}
 */
function parseJournalRecordId(text) {
    if (typeof text !== "string") {
        return makeJournalRecordValidationError(
            "record id must be a string, got " + typeof text,
            "unknown"
        );
    }
    const parts = RECORD_ID_PATTERN.exec(text);
    if (parts === null || parts[1] === undefined || parts[2] === undefined) {
        return makeJournalRecordValidationError(
            "record id must look like <author>:<sequence>, got " + JSON.stringify(text),
            "unknown"
        );
    }
    return makeJournalRecordId(
        makeJournalAuthor(parts[1]),
        makeJournalSequence(parts[2])
    );
}

/**
 * The properties that this class carries are:
 * - `physical` is a non-negative whole-millisecond epoch integer;
 * - `logical` is a non-negative arbitrary-precision integer in canonical
 *   decimal form.
 *
 * The proof of those properties is guaranteed by:
 * - `makeAuthorityTime(physical, logical)`: accepts the value only when
 *   `physical` is a non-negative safe integer and `logical` matches
 *   `SEQUENCE_PATTERN`.
 *
 * `AuthorityTime` is hybrid-logical conflict authority. It is not a persisted
 * value timestamp: nothing derives it from `modifiedAt` except the explicit
 * authority-allocation rules.
 */
class AuthorityTimeClass {
    /**
     * @param {number} physical
     * @param {JournalSequence} logical
     */
    constructor(physical, logical) {
        this.physical = physical;
        this.logical = logical;
        Object.freeze(this);
    }
}

/** @typedef {AuthorityTimeClass} AuthorityTime */

/**
 * @param {unknown} value
 * @returns {value is AuthorityTime}
 */
function isAuthorityTime(value) {
    return value instanceof AuthorityTimeClass;
}

/**
 * @param {number} physical - Epoch milliseconds.
 * @param {string} logical - Canonical decimal non-negative integer.
 * @returns {AuthorityTime | JournalError}
 */
function makeAuthorityTime(physical, logical) {
    if (!Number.isSafeInteger(physical) || physical < 0) {
        return makeJournalRecordValidationError(
            "authority physical time must be a non-negative whole millisecond, got " +
                JSON.stringify(physical),
            "unknown"
        );
    }
    const logicalSequence = makeJournalSequence(logical);
    if (!isJournalSequence(logicalSequence)) {
        return makeJournalRecordValidationError(
            "authority logical time must be a canonical decimal integer, got " +
                JSON.stringify(logical),
            "unknown"
        );
    }
    return new AuthorityTimeClass(physical, logicalSequence);
}

/**
 * Compare authority times: the physical component first, then the
 * arbitrary-precision logical component.
 * @param {AuthorityTime} a
 * @param {AuthorityTime} b
 * @returns {number} negative if a < b, 0 if equal, positive if a > b
 */
function compareAuthorityTime(a, b) {
    if (a.physical !== b.physical) {
        return a.physical - b.physical;
    }
    return compareJournalSequence(a.logical, b.logical);
}

/**
 * The properties that this class carries are:
 * - every coordinate key is a `JournalAuthor`;
 * - every coordinate value is a `JournalSequence`;
 * - no zero coordinate is stored, because a missing coordinate means zero;
 * - the frontier cannot be mutated, so every retained value of this type
 *   describes one immutable cut. The instance is frozen as well, and its stored
 *   coordinates are frozen `JournalAuthor` and `JournalSequence` values.
 *
 * The proof of those properties is guaranteed by:
 * - `makeJournalFrontier(entries)`: rejects non-author keys and non-sequence
 *   values, drops zero coordinates, and stores the coordinates into a
 *   `JournalFrontierClass`, whose mutating `Map` methods throw.
 * - `makeJournalFrontierFromText(entries)`: builds its result with
 *   `makeJournalFrontier`.
 * - `frontierJoin(a, b)`: builds its result with `makeJournalFrontier`.
 *
 * @extends {Map<JournalAuthor, JournalSequence>}
 */
class JournalFrontierClass extends Map {
    constructor() {
        super();
        Object.freeze(this);
    }
    /**
     * @returns {never}
     */
    set() {
        throw new Error("JournalFrontier is immutable");
    }
    /**
     * @returns {never}
     */
    delete() {
        throw new Error("JournalFrontier is immutable");
    }
    /**
     * @returns {never}
     */
    clear() {
        throw new Error("JournalFrontier is immutable");
    }
}

/** @typedef {JournalFrontierClass} JournalFrontier */

/**
 * @param {unknown} value
 * @returns {value is JournalFrontier}
 */
function isJournalFrontier(value) {
    return value instanceof JournalFrontierClass;
}

/**
 * @param {Iterable<[JournalAuthor, JournalSequence]>} entries
 * @returns {JournalFrontier | JournalError}
 */
function makeJournalFrontier(entries) {
    /** @type {Array<[JournalAuthor, JournalSequence]>} */
    const stored = [];
    /** @type {Set<string>} */
    const names = new Set();
    for (const entry of entries) {
        const author = entry[0];
        const sequence = entry[1];
        if (!isJournalAuthor(author) || !isJournalSequence(sequence)) {
            return makeJournalRecordValidationError(
                "frontier coordinates must be journal authors and journal sequences",
                "unknown"
            );
        }
        if (names.has(journalAuthorToString(author))) {
            return makeJournalRecordValidationError(
                "frontier names one writer twice: " + journalAuthorToString(author),
                "unknown"
            );
        }
        names.add(journalAuthorToString(author));
        if (compareJournalSequence(sequence, ZERO_JOURNAL_SEQUENCE) !== 0) {
            stored.push([author, sequence]);
        }
    }
    const frontier = new JournalFrontierClass();
    for (const entry of stored) {
        Map.prototype.set.call(frontier, entry[0], entry[1]);
    }
    return frontier;
}

/**
 * Build a frontier from its textual artifact form, as a canonical bootstrap
 * artifact or a legacy conversion supplies it.
 * @param {Iterable<[string, string]>} entries
 * @returns {JournalFrontier | JournalError}
 */
function makeJournalFrontierFromText(entries) {
    /** @type {Array<[JournalAuthor, JournalSequence]>} */
    const resolved = [];
    for (const entry of entries) {
        const author = makeJournalAuthor(entry[0]);
        const sequence = makeJournalSequence(entry[1]);
        if (!isJournalAuthor(author) || !isJournalSequence(sequence)) {
            return makeJournalRecordValidationError(
                "frontier coordinate " + JSON.stringify(entry) + " is malformed",
                "unknown"
            );
        }
        resolved.push([author, sequence]);
    }
    return makeJournalFrontier(resolved);
}

/**
 * The coordinate of `author` in `frontier`, which is zero when absent.
 * @param {JournalFrontier} frontier
 * @param {JournalAuthor} author
 * @returns {JournalSequence}
 */
function journalSequenceAtFrontier(frontier, author) {
    const direct = frontier.get(author);
    if (direct !== undefined) {
        return direct;
    }
    for (const entry of frontier) {
        if (isSameJournalAuthor(entry[0], author)) {
            return entry[1];
        }
    }
    return ZERO_JOURNAL_SEQUENCE;
}

/**
 * `join(F,G)[A] = max(F[A], G[A])`, the union of two agreeing causally closed
 * prefixes.
 * @param {JournalFrontier} a
 * @param {JournalFrontier} b
 * @returns {JournalFrontier}
 */
function frontierJoin(a, b) {
    /** @type {Map<string, [JournalAuthor, JournalSequence]>} */
    const merged = new Map();
    for (const source of [a, b]) {
        for (const entry of source) {
            const name = journalAuthorToString(entry[0]);
            const existing = merged.get(name);
            if (existing === undefined) {
                merged.set(name, [entry[0], entry[1]]);
                continue;
            }
            if (compareJournalSequence(existing[1], entry[1]) < 0) {
                merged.set(name, [entry[0], entry[1]]);
            }
        }
    }
    const joined = makeJournalFrontier([...merged.values()]);
    if (!isJournalFrontier(joined)) {
        throw new Error("frontierJoin received a coordinate it did not create");
    }
    return joined;
}

/**
 * Writer identity is compared by value, because two separately constructed
 * authors with the same name are the same writer.
 * @param {JournalAuthor} a
 * @param {JournalAuthor} b
 * @returns {boolean}
 */
function isSameJournalAuthor(a, b) {
    return journalAuthorToString(a) === journalAuthorToString(b);
}


module.exports = {
    RECORD_ID_PATTERN,
    SEQUENCE_PATTERN,
    TIMESTAMP_PATTERN,
    ZERO_JOURNAL_SEQUENCE,
    compareAuthorityTime,
    compareJournalSequence,
    frontierJoin,
    isAuthorityTime,
    isJournalAuthor,
    isJournalFrontier,
    isJournalRecordId,
    isJournalSequence,
    isSameJournalAuthor,
    journalAuthorToString,
    journalRecordIdToString,
    journalSequenceAtFrontier,
    journalSequenceToString,
    makeAuthorityTime,
    makeJournalAuthor,
    makeJournalFrontier,
    makeJournalFrontierFromText,
    makeJournalRecordId,
    makeJournalSequence,
    parseJournalRecordId,
    predecessorJournalSequence,
};
