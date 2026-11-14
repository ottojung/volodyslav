/**
 * Reading the current Journal record format.
 *
 * This module is the only place which turns persisted or artifact text into a
 * record. There is no upcast and no downcast path: everything it rejects is
 * rejected in the current format.
 */

const { deserializeNodeKey, nodeKeyStringToString, serializeNodeKey, stringToNodeKeyString } = require("../database");
const {
    makeNodeScope,
    makeProofScope,
    makeValidationBasisEntry,
    makeValueScope,
} = require("./basis");
const { makeJournalRecordValidationError } = require("./errors");
const { contextToText, unexpectedMemberError } = require("./record_fields");
const {
    makeDeleteEvent,
    makeInvalidateEvent,
    makeValidateEvent,
    makeValueEvent,
    makeWriterStateRecord,
} = require("./records");
const {
    isJournalRecordId,
    journalRecordIdToString,
    makeAuthorityTime,
    makeJournalFrontierFromText,
    parseJournalRecordId,
} = require("./types");

/** @typedef {import('./errors').AnyJournalError} JournalError */
/** @typedef {import('./basis').InvalidateScope} InvalidateScope */
/** @typedef {import('./basis').ValidationBasis} ValidationBasis */
/** @typedef {import('./records').JournalRecord} JournalRecord */
/** @typedef {import('./types').AuthorityTime} AuthorityTime */
/** @typedef {import('./types').JournalFrontier} JournalFrontier */
/** @typedef {import('./types').JournalRecordId} JournalRecordId */
/** @typedef {import('./types').NodeKey} NodeKey */

const SEMANTIC_MEMBERS = ["id", "kind", "node", "context", "authorityTime"];
const VALUE_MEMBERS = [...SEMANTIC_MEMBERS, "nodeIdentifier", "payload", "createdAt", "modifiedAt", "reason"];
const DELETE_MEMBERS = [...SEMANTIC_MEMBERS, "reason"];
const VALIDATE_MEMBERS = [...SEMANTIC_MEMBERS, "value", "basis", "reason"];
const INVALIDATE_MEMBERS = [...SEMANTIC_MEMBERS, "scope", "reason"];
const WRITER_STATE_MEMBERS = ["id", "kind", "lastNodeIndex"];

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
 * The persisted member set of one record kind, or undefined for a kind which is
 * not part of the current format.
 * @param {string} kind
 * @returns {ReadonlyArray<string> | undefined}
 */
function membersForKind(kind) {
    if (kind === "value") {
        return VALUE_MEMBERS;
    }
    if (kind === "delete") {
        return DELETE_MEMBERS;
    }
    if (kind === "validate") {
        return VALIDATE_MEMBERS;
    }
    if (kind === "invalidate") {
        return INVALIDATE_MEMBERS;
    }
    if (kind === "writer-state") {
        return WRITER_STATE_MEMBERS;
    }
    return undefined;
}

/**
 * Read a node key from its exact canonical text.
 *
 * The current format stores a node key as the canonical serialization the
 * database's own writer produced, so a persisted node key whose text is merely
 * *parseable* — extra whitespace, reordered members, an unknown member, an
 * argument carrying an unknown member — is not the text this format writes.
 * Accepting it would let the reader re-serialize a different byte sequence than
 * the one it read, so the record's canonical meaning would depend on the reader
 * rather than on the persisted history. The text is therefore compared against the
 * serialization of what it parses to, and anything else is rejected.
 * @param {unknown} value
 * @param {string} label
 * @returns {NodeKey | JournalError}
 */
function readNodeKeyText(value, label) {
    if (typeof value !== "string") {
        return makeJournalRecordValidationError("node key is not canonical text", label);
    }
    /** @type {NodeKey} */
    let node;
    try {
        node = deserializeNodeKey(stringToNodeKeyString(value));
    } catch {
        return makeJournalRecordValidationError("node key is not canonical text", label);
    }
    if (nodeKeyStringToString(serializeNodeKey(node)) !== value) {
        return makeJournalRecordValidationError("node key is not canonical text", label);
    }
    return node;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {JournalRecordId | JournalError}
 */
function readRecordIdText(value, label) {
    const parsed = parseJournalRecordId(value);
    if (isJournalRecordId(parsed)) {
        return parsed;
    }
    return makeJournalRecordValidationError("record id is malformed", label);
}

/**
 * Read a context from its exact canonical coordinate array.
 *
 * A coordinate is a `(writer, sequence)` pair of canonical decimal strings and
 * the array is stored in ascending writer order with no zero coordinate, so every
 * element is required to already be a string and the read array is required to
 * equal the array the encoder would have written for the frontier it produces.
 * Coercing a numeric coordinate to text, or re-ordering a persisted cut, would
 * let the reader accept a byte sequence the current format does not define and
 * hand back a record whose meaning is not the one on disk.
 * @param {unknown} value
 * @param {string} label
 * @returns {JournalFrontier | JournalError}
 */
function readContextText(value, label) {
    if (!Array.isArray(value)) {
        return makeJournalRecordValidationError("context is not a coordinate array", label);
    }
    /** @type {Array<[string, string]>} */
    const entries = [];
    for (const coordinate of value) {
        if (
            !Array.isArray(coordinate) ||
            coordinate.length !== 2 ||
            typeof coordinate[0] !== "string" ||
            typeof coordinate[1] !== "string"
        ) {
            return makeJournalRecordValidationError("context coordinate is malformed", label);
        }
        entries.push([coordinate[0], coordinate[1]]);
    }
    const frontier = makeJournalFrontierFromText(entries);
    if (frontier instanceof Error) {
        return makeJournalRecordValidationError("context coordinate is malformed", label);
    }
    if (JSON.stringify(contextToText(frontier)) !== JSON.stringify(entries)) {
        return makeJournalRecordValidationError("context is not in canonical order", label);
    }
    return frontier;
}

/**
 * Read an authority time from its exact canonical form: a whole-millisecond
 * epoch `physical` number and a canonical decimal `logical` string.
 *
 * The physical component is not coerced from text, because a persisted `"0"`
 * which reads back as the number `0` would be a member the current format does
 * not define silently converted into one that it does.
 * @param {unknown} value
 * @param {string} label
 * @returns {AuthorityTime | JournalError}
 */
function readAuthorityTimeText(value, label) {
    if (!isPlainRecord(value)) {
        return makeJournalRecordValidationError("authority time is malformed", label);
    }
    const unexpected = unexpectedMemberError(value, ["physical", "logical"], label);
    if (unexpected !== undefined) {
        return unexpected;
    }
    if (typeof value["physical"] !== "number" || typeof value["logical"] !== "string") {
        return makeJournalRecordValidationError("authority time is malformed", label);
    }
    const authorityTime = makeAuthorityTime(value["physical"], value["logical"]);
    if (authorityTime instanceof Error) {
        return makeJournalRecordValidationError("authority time is malformed", label);
    }
    return authorityTime;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {ValidationBasis | JournalError}
 */
function readBasisText(value, label) {
    if (!Array.isArray(value)) {
        return makeJournalRecordValidationError("validation basis is not an array", label);
    }
    /** @type {ValidationBasis} */
    const basis = [];
    for (const entry of value) {
        if (!isPlainRecord(entry)) {
            return makeJournalRecordValidationError("validation basis entry is malformed", label);
        }
        const unexpected = unexpectedMemberError(entry, ["input", "value"], label);
        if (unexpected !== undefined) {
            return unexpected;
        }
        const input = readNodeKeyText(entry["input"], label);
        if (input instanceof Error) {
            return input;
        }
        if (entry["value"] === "unknown") {
            basis.push(makeValidationBasisEntry(input, "unknown"));
            continue;
        }
        const basisValue = readRecordIdText(entry["value"], label);
        if (basisValue instanceof Error) {
            return basisValue;
        }
        basis.push(makeValidationBasisEntry(input, basisValue));
    }
    return basis;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {InvalidateScope | JournalError}
 */
function readScopeText(value, label) {
    if (!isPlainRecord(value) || typeof value["kind"] !== "string") {
        return makeJournalRecordValidationError("invalidation scope is malformed", label);
    }
    if (value["kind"] === "node") {
        const unexpected = unexpectedMemberError(value, ["kind"], label);
        return unexpected ?? makeNodeScope();
    }
    if (value["kind"] === "value" || value["kind"] === "proof") {
        const members = value["kind"] === "value" ? ["kind", "value"] : ["kind", "value", "input"];
        const unexpected = unexpectedMemberError(value, members, label);
        if (unexpected !== undefined) {
            return unexpected;
        }
        const scopeValue = readRecordIdText(value["value"], label);
        if (scopeValue instanceof Error) {
            return scopeValue;
        }
        if (value["kind"] === "value") {
            return makeValueScope(scopeValue);
        }
        const input = readNodeKeyText(value["input"], label);
        if (input instanceof Error) {
            return input;
        }
        return makeProofScope(scopeValue, input);
    }
    return makeJournalRecordValidationError("invalidation scope kind is unknown", label);
}

/**
 * Build a current-format record from its canonical plain-object form. Every
 * current-format rule is enforced by the record constructors, so a value this
 * function accepts is a valid current-format record and a value it rejects is
 * not upcast from any other format.
 * @param {unknown} value
 * @returns {JournalRecord | JournalError}
 */
function currentFormatReadRecord(value) {
    if (!isPlainRecord(value) || typeof value["kind"] !== "string") {
        return makeJournalRecordValidationError("record kind is missing", "unknown");
    }
    const id = readRecordIdText(value["id"], "unknown");
    if (id instanceof Error) {
        return id;
    }
    const label = journalRecordIdToString(id);
    const members = membersForKind(value["kind"]);
    if (members === undefined) {
        return makeJournalRecordValidationError(
            "record kind is not part of the current format",
            label
        );
    }
    const unexpected = unexpectedMemberError(value, members, label);
    if (unexpected !== undefined) {
        return unexpected;
    }
    if (value["kind"] === "writer-state") {
        if (typeof value["lastNodeIndex"] !== "number") {
            return makeJournalRecordValidationError("lastNodeIndex is not a number", label);
        }
        return makeWriterStateRecord(id, value["lastNodeIndex"]);
    }
    const node = readNodeKeyText(value["node"], label);
    if (node instanceof Error) {
        return node;
    }
    const context = readContextText(value["context"], label);
    if (context instanceof Error) {
        return context;
    }
    const authorityTime = readAuthorityTimeText(value["authorityTime"], label);
    if (authorityTime instanceof Error) {
        return authorityTime;
    }
    const fields = { id, context, authorityTime, node };
    if (value["kind"] === "value") {
        const payload = value["payload"];
        if (!isPlainRecord(payload)) {
            return makeJournalRecordValidationError("payload is not a computed value", label);
        }
        return makeValueEvent(
            fields,
            value["nodeIdentifier"],
            payload,
            value["createdAt"],
            value["modifiedAt"],
            value["reason"]
        );
    }
    if (value["kind"] === "delete") {
        return makeDeleteEvent(fields, value["reason"]);
    }
    if (value["kind"] === "validate") {
        const target = readRecordIdText(value["value"], label);
        if (target instanceof Error) {
            return target;
        }
        const basis = readBasisText(value["basis"], label);
        if (basis instanceof Error) {
            return basis;
        }
        return makeValidateEvent(fields, target, basis, value["reason"]);
    }
    const scope = readScopeText(value["scope"], label);
    if (scope instanceof Error) {
        return scope;
    }
    return makeInvalidateEvent(fields, scope, value["reason"]);
}

module.exports = {
    currentFormatReadRecord,
    membersForKind,
};
