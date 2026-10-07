/**
 * The canonical current-format Journal record codec.
 *
 * One representation serves the whole active replica. A record carries no
 * per-record version discriminator, so the codec has no upcast and no downcast
 * path: a persisted record which is not valid in the current format is
 * rejected, never converted.
 *
 * The canonical meaning of a record is the JSON text `encodeJournalRecord`
 * produces. Two records with one `JournalRecordId` are a fork exactly when their
 * canonical meanings differ, which is the comparison `well_formedness.js`
 * performs when two retained prefixes overlap.
 */

const { makeJournalRecordValidationError } = require("./errors");
const {
    currentFormatReadRecord,
    membersForKind,
} = require("./codec_read");
const { contextToText } = require("./record_fields");
const { isJournalRecord } = require("./records");
const {
    isJournalRecordId,
    journalRecordIdToString,
    journalSequenceToString,
} = require("./types");

/** @typedef {import('./errors').AnyJournalError} JournalError */
/** @typedef {import('./basis').InvalidateScope} InvalidateScope */
/** @typedef {import('./basis').ValidationBasis} ValidationBasis */
/** @typedef {import('./records').JournalRecord} JournalRecord */
/** @typedef {import('./types').AuthorityTime} AuthorityTime */
/** @typedef {import('./types').JournalFrontier} JournalFrontier */
/** @typedef {import('./types').NodeKey} NodeKey */

/**
 * The canonical text of a node key, as the current format stores it.
 * @param {NodeKey} nodeKey
 * @returns {string}
 */
function nodeKeyToText(nodeKey) {
    return JSON.stringify({ head: nodeKey.head, args: nodeKey.args });
}

/**
 * @param {AuthorityTime} authorityTime
 * @returns {{physical: number, logical: string}}
 */
function authorityTimeToText(authorityTime) {
    return {
        physical: authorityTime.physical,
        logical: journalSequenceToString(authorityTime.logical),
    };
}

/**
 * @param {ValidationBasis} basis
 * @returns {Array<{input: string, value: string}>}
 */
function basisToText(basis) {
    return basis.map((entry) => ({
        input: nodeKeyToText(entry.input),
        value: isJournalRecordId(entry.value) ? journalRecordIdToString(entry.value) : entry.value,
    }));
}

/**
 * @param {InvalidateScope} scope
 * @returns {Record<string, unknown>}
 */
function scopeToText(scope) {
    if (scope.kind === "value") {
        return { kind: scope.kind, value: journalRecordIdToString(scope.value) };
    }
    if (scope.kind === "proof") {
        return {
            kind: scope.kind,
            value: journalRecordIdToString(scope.value),
            input: nodeKeyToText(scope.input),
        };
    }
    return { kind: scope.kind };
}

/**
 * The canonical plain-object form of a record, whose member order is the
 * persisted member order.
 * @param {JournalRecord} record
 * @returns {Record<string, unknown>}
 */
function canonicalRecordBody(record) {
    if (record.kind === "writer-state") {
        return {
            id: journalRecordIdToString(record.id),
            kind: record.kind,
            lastNodeIndex: record.lastNodeIndex,
        };
    }
    const base = {
        id: journalRecordIdToString(record.id),
        kind: record.kind,
        node: nodeKeyToText(record.node),
        context: contextToText(record.context),
        authorityTime: authorityTimeToText(record.authorityTime),
    };
    if (record.kind === "value") {
        return {
            ...base,
            nodeIdentifier: record.nodeIdentifier,
            payload: record.payload,
            createdAt: record.createdAt,
            modifiedAt: record.modifiedAt,
            reason: record.reason,
        };
    }
    if (record.kind === "delete") {
        return { ...base, reason: record.reason };
    }
    if (record.kind === "validate") {
        return {
            ...base,
            value: journalRecordIdToString(record.value),
            basis: basisToText(record.basis),
            reason: record.reason,
        };
    }
    return { ...base, scope: scopeToText(record.scope), reason: record.reason };
}

/**
 * The canonical current-format JSON text of a record.
 * @param {JournalRecord} record
 * @returns {string}
 */
function encodeJournalRecord(record) {
    return JSON.stringify(canonicalRecordBody(record));
}

/**
 * Build a current-format record from its canonical plain-object form.
 * @param {unknown} value
 * @returns {JournalRecord | JournalError}
 */
function currentFormatDecodeRecord(value) {
    return currentFormatReadRecord(value);
}

/**
 * Validate a decoded value against the current record format.
 * @param {unknown} value
 * @returns {JournalError | undefined}
 */
function currentFormatValidateRecord(value) {
    const record = currentFormatReadRecord(value);
    if (isJournalRecord(record)) {
        return undefined;
    }
    return record;
}

/**
 * @param {unknown} text
 * @returns {JournalRecord | JournalError}
 */
function tryDecodeJournalRecord(text) {
    if (typeof text !== "string") {
        return makeJournalRecordValidationError("record text must be a string", "unknown");
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        return makeJournalRecordValidationError("record text is not valid JSON", "unknown");
    }
    return currentFormatReadRecord(parsed);
}

module.exports = {
    canonicalRecordBody,
    currentFormatDecodeRecord,
    currentFormatValidateRecord,
    encodeJournalRecord,
    membersForKind,
    tryDecodeJournalRecord,
};
