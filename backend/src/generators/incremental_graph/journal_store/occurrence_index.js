/**
 * The bounded physical index of the current value occurrence for each semantic
 * node. Its key is a fixed-width digest; the value carries the full canonical
 * identity for explicit collision detection at every read/write boundary.
 */
const { createHash } = require("node:crypto");
const {
    isDeleteEvent,
    isValueEvent,
    journalRecordIdToString,
    makeJournalPublicationError,
    nodeKeyToCanonicalString,
    parseJournalRecordId,
} = require("../journal");
const {
    journalKeyToString,
    journalTextToString,
    stringToJournalKey,
    stringToJournalText,
} = require("../database");

/** @typedef {import("../journal/errors").AnyJournalError} JournalError */
/** @typedef {import("../journal/records").JournalRecord} JournalRecord */
/** @typedef {import("../journal/types").JournalRecordId} JournalRecordId */
/** @typedef {import("../journal/basis").NodeKey} NodeKey */
/** @typedef {import("../database/types").JournalKey} JournalKey */
/** @typedef {import("../database/types").JournalText} JournalText */
/** @typedef {import("../database/root_database").JournalDatabase} JournalDatabase */

const OCCURRENCE_KEY_PREFIX = "occurrence|";

/**
 * Return the fixed-width physical key of the current occurrence index.
 * The canonical semantic identity is retained in the index VALUE for collision
 * detection; it never contributes variable-length text to the physical key.
 * @param {NodeKey} node
 * @returns {JournalKey}
 */
function makeJournalOccurrenceKey(node) {
    const digest = createHash("sha256").update(nodeKeyToCanonicalString(node), "utf8").digest("hex");
    return stringToJournalKey(OCCURRENCE_KEY_PREFIX + digest);
}

/**
 * @param {NodeKey} node
 * @param {JournalRecordId} id
 * @returns {import("../database/types").JournalText}
 */
function makeJournalOccurrenceText(node, id) {
    return stringToJournalText(JSON.stringify({
        node: nodeKeyToCanonicalString(node),
        valueId: journalRecordIdToString(id),
    }));
}

/**
 * @param {import("../database/types").JournalText} text
 * @returns {{node: string, valueId: string} | JournalError}
 */
function decodeJournalOccurrenceText(text) {
    let parsed;
    try {
        parsed = JSON.parse(journalTextToString(text));
    } catch {
        return makeJournalPublicationError("the current occurrence index has invalid JSON");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) ||
        Object.keys(parsed).length !== 2 || typeof parsed.node !== "string" ||
        typeof parsed.valueId !== "string" || !Object.prototype.hasOwnProperty.call(parsed, "node") ||
        !Object.prototype.hasOwnProperty.call(parsed, "valueId")) {
        return makeJournalPublicationError("the current occurrence index has invalid metadata");
    }
    return parsed;
}

/**
 * The record id of a node's current value occurrence, or `undefined` when the node
 * has no Journal value occurrence yet.
 * @param {JournalDatabase} journalDatabase
 * @param {NodeKey} node
 * @returns {Promise<JournalRecordId | undefined | JournalError>}
 */
async function readCurrentOccurrence(journalDatabase, node) {
    const raw = await journalDatabase.get(makeJournalOccurrenceKey(node));
    if (raw === undefined) {
        return undefined;
    }
    const value = decodeJournalOccurrenceText(raw);
    if (value instanceof Error) {
        return value;
    }
    if (value.node !== nodeKeyToCanonicalString(node)) {
        return makeJournalPublicationError(
            "the current occurrence index has a physical key collision for " + value.node
        );
    }
    return parseJournalRecordId(value.valueId);
}

/**
 * Refuse collisions with either another record in this publication or an
 * already committed index row, before constructing any database writes.
 *
 * @param {JournalDatabase} journalDatabase
 * @param {ReadonlyArray<JournalRecord>} records
 * @returns {Promise<JournalError | undefined>}
 */
async function checkOccurrenceIndexCollisions(journalDatabase, records) {
    // Check every touched index key before any operation is appended. This
    // refuses even a theoretical SHA-256 collision rather than replacing the
    // current occurrence of a different semantic node.
    const touched = new Map();
    for (const record of records) {
        if (!isValueEvent(record) && !isDeleteEvent(record)) {
            continue;
        }
        const indexKey = makeJournalOccurrenceKey(record.node);
        const keyText = journalKeyToString(indexKey);
        const nodeText = nodeKeyToCanonicalString(record.node);
        const priorNode = touched.get(keyText);
        if (priorNode !== undefined && priorNode !== nodeText) {
            return makeJournalPublicationError("colliding semantic nodes in one journal publication");
        }
        touched.set(keyText, nodeText);
    }
    for (const [keyText, nodeText] of touched) {
        const raw = await journalDatabase.get(stringToJournalKey(keyText));
        if (raw === undefined) {
            continue;
        }
        const existing = decodeJournalOccurrenceText(raw);
        if (existing instanceof Error) {
            return existing;
        }
        if (existing.node !== nodeText) {
            return makeJournalPublicationError("colliding semantic nodes in the persisted occurrence index");
        }
    }
    return undefined;
}

module.exports = {
    checkOccurrenceIndexCollisions,
    decodeJournalOccurrenceText,
    makeJournalOccurrenceKey,
    makeJournalOccurrenceText,
    readCurrentOccurrence,
};
