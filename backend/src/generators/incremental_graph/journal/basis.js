/**
 * The semantic node key helpers, the self-describing validation basis, and the
 * three invalidation scopes.
 *
 * These shapes are the record layer vocabulary for what one historical
 * validation claimed, and for which incoming proof edge an invalidation retires.
 * The basis and the scopes are nominal: a plain array or a plain scope object can
 * never be mistaken for a validated one.
 */

const {
    compareNodeKeyStringByNodeKey,
    nodeKeyStringToString,
    serializeNodeKey,
    stringToNodeKeyString,
} = require("../database");
const { isJournalRecordId, parseJournalRecordId } = require("./types");

/** @typedef {import("../database/node_key").NodeKey} NodeKey */
/** @typedef {import("./types").JournalRecordId} JournalRecordId */

const CANONICAL_BASIS_REASONS = ["bootstrap", "reset", "migration"];

/**
 * @param {unknown} value
 * @returns {value is NodeKey}
 */
function isNodeKey(value) {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    if (!("head" in value) || typeof value.head !== "string") {
        return false;
    }
    return "args" in value && Array.isArray(value.args);
}

/**
 * The canonical persisted semantic identity of a NodeKey. The canonical
 * `ValidationBasis` order compares these strings, and it is deliberately not
 * the typed `compareNodeKey()` order.
 * @param {NodeKey} nodeKey
 * @returns {string}
 */
function nodeKeyToCanonicalString(nodeKey) {
    return nodeKeyStringToString(serializeNodeKey(nodeKey));
}

/**
 * The reasons whose validation may carry `"unknown"` basis entries. An ordinary
 * compute, unchanged or cache-revalidate certificate must not use `"unknown"`.
 * @param {string} reason
 * @returns {boolean}
 */
function isBaselineValidationReason(reason) {
    return CANONICAL_BASIS_REASONS.includes(reason);
}

/**
 * The properties that this class carries are:
 * - `input` is a `NodeKey`;
 * - `value` is either a `JournalRecordId` (a ValueId) or the exact string
 *   `"unknown"`. The two can never be confused, because `"unknown"` is not an
 *   `instanceof JournalRecordIdClass` and `"unknown"` never equals a ValueId.
 *
 * The proof of those properties is guaranteed by:
 * - `makeValidationBasisEntry(input, value)`: accepts only a `NodeKey` input and
 *   either a `JournalRecordId` or the literal `"unknown"`.
 * - the current-format reader in `codec_read.js`: builds a basis entry only
 *   through `makeValidationBasisEntry`, from a canonical NodeKey text and either
 *   a parsed record id or `"unknown"`.
 */
class ValidationBasisEntryClass {
    /**
     * @param {NodeKey} input
     * @param {JournalRecordId | "unknown"} value
     */
    constructor(input, value) {
        this.input = input;
        this.value = value;
    }
}

/** @typedef {ValidationBasisEntryClass} ValidationBasisEntry */

/**
 * @param {unknown} value
 * @returns {value is ValidationBasisEntry}
 */
function isValidationBasisEntry(value) {
    return value instanceof ValidationBasisEntryClass;
}

/**
 * @param {NodeKey} input
 * @param {JournalRecordId | string | "unknown"} value - A ValueId, its textual
 *   form, or the literal "unknown".
 * @returns {ValidationBasisEntry}
 */
function makeValidationBasisEntry(input, value) {
    if (!isNodeKey(input)) {
        throw new Error("validation basis entry requires a node key");
    }
    return new ValidationBasisEntryClass(input, readBasisValue(value));
}

/**
 * @param {JournalRecordId | string | "unknown"} value
 * @returns {JournalRecordId | "unknown"}
 */
function readBasisValue(value) {
    if (value === "unknown") {
        return "unknown";
    }
    if (isJournalRecordId(value)) {
        return value;
    }
    const parsed = parseJournalRecordId(value);
    if (!isJournalRecordId(parsed)) {
        throw new Error("validation basis value must be a record id or \"unknown\"");
    }
    return parsed;
}

/**
 * A validation basis, in canonical persisted NodeKey order, with at most one
 * entry for each semantic input NodeKey.
 * @typedef {Array<ValidationBasisEntry>} ValidationBasis
 */

/**
 * Order basis entries by the canonical persisted identity of their input.
 * @param {ValidationBasis} basis
 * @returns {ValidationBasis}
 */
function sortValidationBasis(basis) {
    return basis
        .slice()
        .sort((a, b) =>
            compareNodeKeyStringByNodeKey(
                stringToNodeKeyString(nodeKeyToCanonicalString(a.input)),
                stringToNodeKeyString(nodeKeyToCanonicalString(b.input))
            )
        );
}

/**
 * The properties that these classes carry are:
 * - the scope is exactly one of the three named variants;
 * - a node scope has no ValueId member at all, so it can never reference a value
 *   occurrence;
 * - a `value` scope names a `JournalRecordId`;
 * - a `proof` scope names a `JournalRecordId` and a `NodeKey` input.
 *
 * The proof of those properties is guaranteed by:
 * - `makeNodeScope()`, `makeValueScope(value)` and `makeProofScope(value, input)`:
 *   each accepts only the members its variant defines, and each class has exactly
 *   those members.
 * - the current-format reader in `codec_read.js`: dispatches on `kind` and
 *   accepts only the exact member set of the named variant.
 */
class NodeScopeClass {
    /** @type {"node"} */
    kind = "node";
}

/** @typedef {NodeScopeClass} NodeScope */

class ValueScopeClass {
    /** @type {"value"} */
    kind = "value";
    /**
     * @param {JournalRecordId} value
     */
    /**
     * @param {JournalRecordId} value
     */
    constructor(value) {
        this.value = value;
    }
}

/** @typedef {ValueScopeClass} ValueScope */

class ProofScopeClass {
    /** @type {"proof"} */
    kind = "proof";
    /**
     * @param {JournalRecordId} value
     * @param {NodeKey} input
     */
    constructor(value, input) {
        this.value = value;
        this.input = input;
    }
}

/** @typedef {ProofScopeClass} ProofScope */

/**
 * @typedef {NodeScope | ValueScope | ProofScope} InvalidateScope
 */

/**
 * @param {unknown} value
 * @returns {value is InvalidateScope}
 */
function isInvalidateScope(value) {
    return (
        value instanceof NodeScopeClass ||
        value instanceof ValueScopeClass ||
        value instanceof ProofScopeClass
    );
}

/**
 * @returns {NodeScope}
 */
function makeNodeScope() {
    return new NodeScopeClass();
}

/**
 * @param {JournalRecordId | string} value
 * @returns {ValueScope}
 */
function makeValueScope(value) {
    return new ValueScopeClass(readValueId(value));
}

/**
 * @param {JournalRecordId | string} value
 * @param {NodeKey} input
 * @returns {ProofScope}
 */
function makeProofScope(value, input) {
    if (!isNodeKey(input)) {
        throw new Error("proof scope requires a node key input");
    }
    return new ProofScopeClass(readValueId(value), input);
}

/**
 * @param {JournalRecordId | string} value
 * @returns {JournalRecordId}
 */
function readValueId(value) {
    if (isJournalRecordId(value)) {
        return value;
    }
    const parsed = parseJournalRecordId(value);
    if (!isJournalRecordId(parsed)) {
        throw new Error("invalidation scope requires a record id value");
    }
    return parsed;
}

module.exports = {
    isBaselineValidationReason,
    isInvalidateScope,
    isNodeKey,
    isValidationBasisEntry,
    makeNodeScope,
    makeProofScope,
    makeValidationBasisEntry,
    makeValueScope,
    nodeKeyToCanonicalString,
    sortValidationBasis,
};
