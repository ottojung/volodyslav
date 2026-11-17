/**
 * The record-valued field codecs of the durable retained replay state.
 *
 * The state's head selection, resolved certificates and selected occurrences are all
 * expressed in terms of the Journal layer's own canonical record text and identity
 * helpers, so a state which round-trips names exactly the records the Journal sublevel
 * stores. This module owns those fields; `state_codec_scopes.js` owns the counted
 * summary's scope maxima and `state_codec.js` assembles the state.
 *
 * A field which does not decode is reported as an error rather than partially accepted,
 * which is what lets the entry point treat a malformed summary as the missing/stale case
 * §Change-bounded proof summary reserves for explicit rebuild/maintenance.
 */

/** @typedef {import('../journal/errors').AnyJournalError} JournalError */
/** @typedef {import('../journal/records').JournalRecord} JournalRecord */
/** @typedef {import('../journal/records').ValidateEvent} ValidateEvent */
/** @typedef {import('../journal/types').JournalRecordId} JournalRecordId */
/** @typedef {import('../journal/oracle/certificates').SelectedCertificate} SelectedCertificate */
/** @typedef {import('../journal/oracle/heads').HeadSelection} HeadSelection */

const {
    HeadSelectionClass,
    SelectedCertificateClass,
    encodeJournalRecord,
    isDeleteEvent,
    isValidateEvent,
    isValueEvent,
    journalRecordIdToString,
    makeJournalSourceReadError,
    parseJournalRecordId,
    tryDecodeJournalRecord,
} = require("../journal");

/**
 * The format tag every encoded state carries, so a value which is not a retained
 * replay state is rejected before any field is read.
 */
const RETAINED_STATE_FORMAT = "volodyslav.journal.retained-replay-state";

/**
 * The codec version. A reader accepts exactly the versions it knows; an unknown
 * version is the missing/stale case rather than a value to guess at.
 */
const RETAINED_STATE_VERSION = 1;

/**
 * @param {string} where
 * @returns {JournalError}
 */
function malformed(where) {
    return makeJournalSourceReadError(
        "the persisted retained replay state is malformed at " + where
    );
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {unknown}
 */
function fieldOf(value, name) {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }
    return Reflect.get(value, name);
}

/**
 * @template T
 * @param {T} left
 * @param {T} right
 * @returns {number}
 */
function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * @param {unknown} value
 * @param {string} what
 * @returns {Map<string, JournalRecord> | JournalError}
 */
function decodeRecordMap(value, what) {
    if (!Array.isArray(value)) {
        return malformed(what);
    }
    /** @type {Map<string, JournalRecord>} */
    const records = new Map();
    for (const entry of value) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || typeof entry[1] !== "string") {
            return malformed(what + " entry");
        }
        const record = tryDecodeJournalRecord(entry[1]);
        if (record instanceof Error) {
            return record;
        }
        records.set(entry[0], record);
    }
    return records;
}

/**
 * Rebuild one map of record-id-keyed validation records.
 *
 * The counted summary only ever admits validations into this map, so a record which is
 * not a validation is malformed summary content rather than a state to consume.
 *
 * @param {unknown} value
 * @param {string} what
 * @returns {Map<string, ValidateEvent> | JournalError}
 */
function decodeValidationMap(value, what) {
    const records = decodeRecordMap(value, what);
    if (records instanceof Error) {
        return records;
    }
    /** @type {Map<string, ValidateEvent>} */
    const validations = new Map();
    for (const [recordId, record] of records) {
        if (!isValidateEvent(record)) {
            return malformed(what + " record which is not a validation");
        }
        validations.set(recordId, record);
    }
    return validations;
}

/**
 * One selected-occurrence map as sorted `[nodeKeyString, recordIdText]` pairs.
 * @param {Map<string, JournalRecordId>} selected
 * @returns {Array<[string, string]>}
 */
function encodeSelected(selected) {
    return [...selected.entries()]
        .sort(([left], [right]) => compareText(left, right))
        .map(([nodeKeyString, recordId]) => [nodeKeyString, journalRecordIdToString(recordId)]);
}

/**
 * @param {unknown} value
 * @param {string} what
 * @returns {Map<string, JournalRecordId> | JournalError}
 */
function decodeSelected(value, what) {
    if (!Array.isArray(value)) {
        return malformed(what);
    }
    /** @type {Map<string, JournalRecordId>} */
    const selected = new Map();
    for (const entry of value) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || typeof entry[1] !== "string") {
            return malformed(what + " entry");
        }
        const recordId = parseJournalRecordId(entry[1]);
        if (recordId instanceof Error) {
            return recordId;
        }
        selected.set(entry[0], recordId);
    }
    return selected;
}

/**
 * The head selection as `[nodeKeyString, encodedRecord]` pairs.
 * @param {Map<string, HeadSelection>} heads
 * @returns {Array<[string, string]>}
 */
function encodeHeads(heads) {
    /** @type {Array<[string, string]>} */
    const encoded = [];
    for (const [nodeKeyString, selection] of heads) {
        if (selection.winner === undefined) {
            continue;
        }
        encoded.push([nodeKeyString, encodeJournalRecord(selection.winner)]);
    }
    return encoded;
}

/**
 * @param {unknown} value
 * @returns {Map<string, HeadSelection> | JournalError}
 */
function decodeHeads(value) {
    const records = decodeRecordMap(value, "heads");
    if (records instanceof Error) {
        return records;
    }
    /** @type {Map<string, HeadSelection>} */
    const heads = new Map();
    for (const [nodeKeyString, record] of records) {
        if (!isValueEvent(record) && !isDeleteEvent(record)) {
            return malformed("a head record which is not a value or delete event");
        }
        heads.set(nodeKeyString, new HeadSelectionClass(record.node, record));
    }
    return heads;
}

/**
 * @param {Map<string, SelectedCertificate>} certificates
 * @returns {Array<[string, {record: string, effectiveInputs: string[], covers: boolean}]>}
 */
function encodeCertificates(certificates) {
    /** @type {Array<[string, {record: string, effectiveInputs: string[], covers: boolean}]>} */
    const encoded = [];
    for (const [nodeKeyString, selected] of certificates) {
        encoded.push([
            nodeKeyString,
            {
                record: encodeJournalRecord(selected.certificate),
                effectiveInputs: [...selected.effectiveInputs].sort(),
                covers: selected.coversValueInvalidations,
            },
        ]);
    }
    return encoded;
}

/**
 * @param {unknown} value
 * @returns {Map<string, SelectedCertificate> | JournalError}
 */
function decodeCertificates(value) {
    if (!Array.isArray(value)) {
        return malformed("certificates");
    }
    /** @type {Map<string, SelectedCertificate>} */
    const certificates = new Map();
    for (const entry of value) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") {
            return malformed("certificates entry");
        }
        const body = entry[1];
        if (
            typeof body !== "object" ||
            body === null ||
            typeof Reflect.get(body, "record") !== "string" ||
            !Array.isArray(Reflect.get(body, "effectiveInputs")) ||
            Reflect.get(body, "effectiveInputs").some((/** @type {unknown} */ key) => typeof key !== "string") ||
            typeof Reflect.get(body, "covers") !== "boolean"
        ) {
            return malformed("certificates entry body");
        }
        const record = tryDecodeJournalRecord(Reflect.get(body, "record"));
        if (record instanceof Error) {
            return record;
        }
        if (!isValidateEvent(record)) {
            return malformed("a certificate record which is not a validation");
        }
        certificates.set(
            entry[0],
            new SelectedCertificateClass(
                record,
                new Set(Reflect.get(body, "effectiveInputs")),
                Reflect.get(body, "covers")
            )
        );
    }
    return certificates;
}

module.exports = {
    RETAINED_STATE_FORMAT,
    RETAINED_STATE_VERSION,
    compareText,
    decodeCertificates,
    decodeHeads,
    decodeRecordMap,
    decodeSelected,
    decodeValidationMap,
    encodeCertificates,
    encodeHeads,
    encodeSelected,
    fieldOf,
    malformed,
};
