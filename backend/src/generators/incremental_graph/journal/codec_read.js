/**
 * Reading the current Journal record format.
 *
 * This module is the only place which turns persisted or artifact text into a
 * record. There is no upcast and no downcast path: everything it rejects is
 * rejected in the current format.
 */

const { deserializeNodeKey, stringToNodeKeyString } = require("../database");
const {
    makeNodeScope,
    makeProofScope,
    makeValidationBasisEntry,
    makeValueScope,
} = require("./basis");
const { makeJournalRecordValidationError } = require("./errors");
const { unexpectedMemberError } = require("./record_fields");
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
 * @param {unknown} value
 * @param {string} label
 * @returns {NodeKey | JournalError}
 */
function readNodeKeyText(value, label) {
    if (typeof value !== "string") {
        return makeJournalRecordValidationError("node key is not canonical text", label);
    }
    try {
        return deserializeNodeKey(stringToNodeKeyString(value));
    } catch {
        return makeJournalRecordValidationError("node key is not canonical text", label);
    }
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
        if (!Array.isArray(coordinate) || coordinate.length !== 2) {
            return makeJournalRecordValidationError("context coordinate is malformed", label);
        }
        entries.push([String(coordinate[0]), String(coordinate[1])]);
    }
    const frontier = makeJournalFrontierFromText(entries);
    if (frontier instanceof Error) {
        return makeJournalRecordValidationError("context coordinate is malformed", label);
    }
    return frontier;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {AuthorityTime | JournalError}
 */
function readAuthorityTimeText(value, label) {
    if (!isPlainRecord(value)) {
        return makeJournalRecordValidationError("authority time is malformed", label);
    }
    const logical = typeof value["logical"] === "string" ? value["logical"] : "";
    const authorityTime = makeAuthorityTime(Number(value["physical"]), logical);
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
