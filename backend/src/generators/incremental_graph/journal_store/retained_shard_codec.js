/**
 * One retained proof-summary node per fixed-width hashed physical key.
 *
 * Writer metadata is a separate small record. Shards contain the full canonical
 * node identity in their VALUE, so even a SHA-256 collision cannot conflate nodes.
 * Heads name their immutable Journal record IDs rather than duplicating payloads.
 */

const { createHash } = require("node:crypto");
const {
    journalAuthorToString,
    journalRecordIdToString,
    journalSequenceToString,
} = require("../journal");
const {
    RETAINED_STATE_FORMAT,
    RETAINED_STATE_VERSION,
    ProofSummaryClass,
    encodeCertificates,
    encodeSelected,
    encodeProofs,
} = require("../journal_retained");

/** @typedef {import('../journal_retained/retained').RetainedReplayState} RetainedReplayState */

const NODE_PREFIX = "retained_state|node|";

/** @param {string} node */
function shardKeyText(node) {
    return NODE_PREFIX + createHash("sha256").update(node, "utf8").digest("hex");
}

/**
 * @template V
 * @param {ReadonlyMap<string, V>} mapping
 * @param {string} node
 * @returns {Map<string, V>}
 */
function onlyNode(mapping, node) {
    const value = mapping.get(node);
    return value === undefined ? new Map() : new Map([[node, value]]);
}

/** @param {RetainedReplayState} state */
function nodeNamesOf(state) {
    const names = new Set();
    for (const mapping of [
        state.heads, state.certificates, state.selected, state.proofs.selected,
        state.proofs.certificates, state.proofs.nodeScoped, state.proofs.valueScoped,
        state.proofs.proofScoped,
    ]) {
        for (const name of mapping.keys()) names.add(name);
    }
    for (const name of state.touched) names.add(name);
    return names;
}

/** @param {RetainedReplayState} state @param {string} node */
function encodeNodeShard(state, node) {
    const proofs = state.proofs;
    const selected = state.heads.get(node);
    const summary = new ProofSummaryClass(
        onlyNode(proofs.selected, node), proofs.currentInputKeysOfNode,
        onlyNode(proofs.certificates, node), onlyNode(proofs.nodeScoped, node),
        onlyNode(proofs.valueScoped, node), onlyNode(proofs.proofScoped, node)
    );
    return JSON.stringify({
        node,
        headId: selected?.winner === undefined
            ? null : journalRecordIdToString(selected.winner.id),
        selected: encodeSelected(onlyNode(state.selected, node)),
        certificates: encodeCertificates(onlyNode(state.certificates, node)),
        proofs: encodeProofs(summary),
    });
}

/** @param {RetainedReplayState} state */
function encodeShardMetadata(state) {
    return JSON.stringify({
        format: RETAINED_STATE_FORMAT,
        version: RETAINED_STATE_VERSION,
        localWriter: journalAuthorToString(state.localWriter),
        lastNodeIndex: state.lastNodeIndex,
        writers: [...state.writers.keys()].sort(),
        admittedLengths: [...state.admittedLengths]
            .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
            .map(([name, sequence]) => [name, journalSequenceToString(sequence)]),
        touched: [...state.touched].sort(),
    });
}

/**
 * The aggregate is transient: only one node shard is loaded at a time.
 * @param {object} metadata
 * @returns {{
 *   heads: Array<[string, string]>,
 *   selected: Array<unknown>,
 *   certificates: Array<unknown>,
 *   proofs: {
 *     selected: Array<unknown>, certificates: Array<unknown>,
 *     nodeScoped: Array<unknown>, valueScoped: Array<unknown>,
 *     proofScoped: Array<unknown>
 *   }
 * }}
 */
function emptyStateFromMetadata(metadata) {
    return {
        ...metadata,
        heads: [],
        selected: [],
        certificates: [],
        proofs: {
            selected: [], certificates: [], nodeScoped: [],
            valueScoped: [], proofScoped: [],
        },
    };
}

module.exports = {
    NODE_PREFIX, encodeNodeShard, encodeShardMetadata,
    emptyStateFromMetadata, nodeNamesOf, shardKeyText,
};
