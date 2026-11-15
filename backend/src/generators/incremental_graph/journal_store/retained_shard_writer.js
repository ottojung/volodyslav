/**
 * Append a sharded retained replay summary to the caller's ATOMIC batch.
 *
 * An ordinary publication only touches its affected nodes. Explicit
 * rebuilds/recovery/reset replace every shard and delete stale inactive shards.
 * The active shard-set fingerprint is published in the same batch as the
 * Journal records, so a missing, injected or corrupted shard fails closed.
 */
const {
    journalKeyToString, journalTextToString, stringToJournalKey, stringToJournalText,
} = require("../database");
const { makeJournalPublicationError } = require("../journal");
const {
    NODE_PREFIX, encodeNodeShard, encodeShardMetadata, nodeNamesOf, shardKeyText,
} = require("./retained_shard_codec");
const { ZERO_DIGEST, memberDigest, xorDigest } = require("./retained_shard_integrity");

/** @typedef {import('../database/root_database').JournalDatabase} JournalDatabase */
/** @typedef {import('../journal_retained').RetainedReplayState} RetainedReplayState */
/** @typedef {import('../database/types').DatabaseBatchOperation} DatabaseBatchOperation */

const META_KEY = stringToJournalKey("retained_state");

/** @param {RetainedReplayState} state @param {string} node */
function hasNodeShard(state, node) {
    return [
        state.heads, state.selected, state.certificates,
        state.proofs.selected, state.proofs.certificates,
        state.proofs.nodeScoped, state.proofs.valueScoped, state.proofs.proofScoped,
    ].some(map => map.has(node)) || state.touched.has(node);
}

/**
 * @param {JournalDatabase} db
 * @param {string} keyText
 * @param {string} node
 * @returns {Promise<Error | undefined>}
 */
async function checkShardIdentity(db, keyText, node) {
    const old = await db.get(stringToJournalKey(keyText));
    if (old === undefined) return undefined;
    let parsed;
    try { parsed = JSON.parse(journalTextToString(old)); }
    catch { return makeJournalPublicationError("the persisted node shard is not JSON"); }
    if (parsed?.node !== node) {
        return makeJournalPublicationError("a persisted retained node shard has a hashed-key collision");
    }
    return undefined;
}

/**
 * @param {JournalDatabase} journalDatabase
 * @param {Array<DatabaseBatchOperation>} operations
 * @param {RetainedReplayState} state
 * @returns {Promise<Error | undefined>}
 */
async function appendShardedStateOps(journalDatabase, operations, state) {
    const delta = state.persistAffected !== undefined &&
        state.shardDigests !== undefined && state.shardAccumulator !== undefined;
    const targets = delta && state.persistAffected !== undefined
        ? state.persistAffected : nodeNamesOf(state);
    const names = [...targets].sort();
    const digests = delta && state.shardDigests !== undefined
        ? state.shardDigests : new Map();
    let accumulator = delta && state.shardAccumulator !== undefined
        ? state.shardAccumulator : ZERO_DIGEST;
    /** @type {Set<string>} */
    const retained = new Set();
    for (const node of names) {
        const keyText = shardKeyText(node);
        retained.add(keyText);
        const collision = await checkShardIdentity(journalDatabase, keyText, node);
        if (collision !== undefined) return collision;
        const previous = digests.get(node);
        if (previous !== undefined) accumulator = xorDigest(accumulator, previous);
        if (!hasNodeShard(state, node)) {
            operations.push(journalDatabase.delOp(stringToJournalKey(keyText)));
            digests.delete(node);
            continue;
        }
        const value = encodeNodeShard(state, node);
        const digest = memberDigest(keyText, value);
        accumulator = xorDigest(accumulator, digest);
        digests.set(node, digest);
        operations.push(journalDatabase.putOp(
            stringToJournalKey(keyText), stringToJournalText(value)
        ));
    }
    if (!delta) {
        for await (const oldKey of journalDatabase.keys({
            gte: stringToJournalKey(NODE_PREFIX),
            lt: stringToJournalKey("retained_state|node}"),
        })) {
            const physical = journalKeyToString(oldKey);
            if (physical.startsWith(NODE_PREFIX) && !retained.has(physical)) {
                operations.push(journalDatabase.delOp(oldKey));
            }
        }
    }
    const metadata = JSON.parse(encodeShardMetadata(state));
    metadata.nodeCount = digests.size;
    metadata.nodeDigest = accumulator;
    operations.push(journalDatabase.putOp(
        META_KEY, stringToJournalText(JSON.stringify(metadata))
    ));
    state.shardDigests = digests;
    state.shardAccumulator = accumulator;
    state.persistAffected = undefined;
    return undefined;
}

module.exports = { META_KEY, appendShardedStateOps };
