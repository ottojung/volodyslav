/**
 * Reconstruct the retained replay state only from the indexed node-shard range.
 * Retained Journal record history is never enumerated to obtain the summary.
 */
const {
    isDeleteEvent, isValueEvent, journalAuthorToString, journalRecordIdToString,
    journalSequenceToString, makeJournalSourceReadError,
    nodeKeyToCanonicalString, parseJournalRecordId, tryDecodeJournalRecord,
} = require("../journal");
const {
    journalKeyToString, journalTextToString, stringToJournalKey,
} = require("../database");
const { deserializeRetainedReplayState } = require("../journal_retained");
const { encodeRecordCoordinate } = require("./record_coordinate_key");
const {
    NODE_PREFIX, emptyStateFromMetadata, shardKeyText,
} = require("./retained_shard_codec");
const { ZERO_DIGEST, memberDigest, xorDigest } = require("./retained_shard_integrity");

/** @typedef {import('../database/root_database').JournalDatabase} JournalDatabase */
/** @typedef {import('../journal_retained').CurrentInputKeysOfNode} CurrentInputKeysOfNode */
/** @typedef {import('../journal/types').JournalAuthor} JournalAuthor */

/**
 * @param {JournalDatabase} journalDatabase
 * @param {string} recordIdText
 * @param {string} node
 * @returns {Promise<string | Error>}
 */
async function encodedHead(journalDatabase, recordIdText, node) {
    const id = parseJournalRecordId(recordIdText);
    if (id instanceof Error) return id;
    const key = stringToJournalKey(
        "record|" + journalAuthorToString(id.author) + "|" +
        encodeRecordCoordinate(journalSequenceToString(id.sequence))
    );
    let raw;
    for await (const [recordKey, text] of journalDatabase.entries({
        gte: key, lte: key, limit: 1,
    })) {
        if (recordKey === key) raw = text;
        break;
    }
    if (raw === undefined) {
        return makeJournalSourceReadError("the retained summary names a missing head record " + recordIdText);
    }
    const text = journalTextToString(raw);
    const record = tryDecodeJournalRecord(text);
    if (record instanceof Error) return record;
    if ((!isValueEvent(record) && !isDeleteEvent(record)) ||
        nodeKeyToCanonicalString(record.node) !== node ||
        journalRecordIdToString(record.id) !== recordIdText) {
        return makeJournalSourceReadError("a retained head shard disagrees with its Journal record");
    }
    return text;
}

/**
 * @param {JournalDatabase} journalDatabase
 * @param {unknown} meta
 * @param {{localWriter: JournalAuthor, currentInputKeysOfNode: CurrentInputKeysOfNode}} request
 * @returns {Promise<import('../journal_retained').RetainedReplayState | Error>}
 */
async function readShardState(journalDatabase, meta, request) {
    if (meta === null || typeof meta !== "object" ||
        !Number.isSafeInteger(Reflect.get(meta, "nodeCount")) ||
        Reflect.get(meta, "nodeCount") < 0 ||
        !/^[0-9a-f]{64}$/.test(String(Reflect.get(meta, "nodeDigest")))) {
        return makeJournalSourceReadError("the retained summary has malformed shard-integrity metadata");
    }
    const reconstructed = emptyStateFromMetadata(meta);
    /** @type {Map<string, string>} */
    const digests = new Map();
    let accumulator = ZERO_DIGEST;
    for await (const key of journalDatabase.keys({
        gte: stringToJournalKey(NODE_PREFIX),
        lt: stringToJournalKey("retained_state|node}"),
    })) {
        const physical = journalKeyToString(key);
        if (!physical.startsWith(NODE_PREFIX)) continue;
        const textValue = await journalDatabase.get(key);
        if (textValue === undefined) {
            return makeJournalSourceReadError("a retained summary shard disappeared during read");
        }
        const text = journalTextToString(textValue);
        let shard;
        try {
            shard = JSON.parse(text);
        } catch {
            return makeJournalSourceReadError("a retained summary shard is not valid JSON");
        }
        if (shard === null || typeof shard !== "object" ||
            typeof shard.node !== "string" || physical !== shardKeyText(shard.node) ||
            digests.has(shard.node)) {
            return makeJournalSourceReadError("a retained summary shard's physical identity is inconsistent");
        }
        const digest = memberDigest(physical, text);
        digests.set(shard.node, digest);
        accumulator = xorDigest(accumulator, digest);
        const failure = await appendShard(journalDatabase, reconstructed, shard);
        if (failure !== undefined) return failure;
    }
    if (digests.size !== Reflect.get(meta, "nodeCount") ||
        accumulator !== Reflect.get(meta, "nodeDigest")) {
        return makeJournalSourceReadError("the persisted retained summary has missing or corrupt node shards");
    }
    const decoded = deserializeRetainedReplayState(JSON.stringify(reconstructed), request);
    if (decoded instanceof Error) return decoded;
    decoded.shardDigests = digests;
    decoded.shardAccumulator = accumulator;
    return decoded;
}

/**
 * @param {JournalDatabase} journalDatabase
 * @param {ReturnType<typeof emptyStateFromMetadata>} reconstructed
 * @param {object} shard
 * @returns {Promise<Error | undefined>}
 */
async function appendShard(journalDatabase, reconstructed, shard) {
    const node = Reflect.get(shard, "node");
    const id = Reflect.get(shard, "headId");
    if (id !== null && typeof id !== "string") {
        return makeJournalSourceReadError("a retained node shard has an invalid head reference");
    }
    if (id !== null) {
        const text = await encodedHead(journalDatabase, id, node);
        if (text instanceof Error) return text;
        reconstructed.heads.push([node, text]);
    }
    for (const field of ["selected", "certificates"]) {
        const values = Reflect.get(shard, field);
        if (!Array.isArray(values)) {
            return makeJournalSourceReadError("a retained node shard has invalid " + field);
        }
        if (field === "selected") reconstructed.selected.push(...values);
        else reconstructed.certificates.push(...values);
    }
    const proofs = Reflect.get(shard, "proofs");
    if (!proofs || typeof proofs !== "object") {
        return makeJournalSourceReadError("a retained node shard has no proof state");
    }
    for (const field of [
        "selected", "certificates", "nodeScoped", "valueScoped", "proofScoped",
    ]) {
        const values = Reflect.get(proofs, field);
        if (!Array.isArray(values)) {
            return makeJournalSourceReadError("a retained node shard has invalid proof " + field);
        }
        if (field === "selected") reconstructed.proofs.selected.push(...values);
        else if (field === "certificates") reconstructed.proofs.certificates.push(...values);
        else if (field === "nodeScoped") reconstructed.proofs.nodeScoped.push(...values);
        else if (field === "valueScoped") reconstructed.proofs.valueScoped.push(...values);
        else reconstructed.proofs.proofScoped.push(...values);
    }
    return undefined;
}

module.exports = { readShardState };
