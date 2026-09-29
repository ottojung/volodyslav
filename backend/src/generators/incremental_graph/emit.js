/**
 * The Journal intents one settled graph write stages.
 *
 * A graph write is only half of a publication: the other half is the semantic event
 * which explains it. These functions are the single place where a graph write is
 * paired with its intent, so no write path can settle a transition without also
 * stating what the transition means. The intents are staged on the transaction; the
 * commit seam finalizes them into records of the same atomic write.
 *
 * A certificate names the value occurrence of each current direct input. The
 * occurrence is the committed one, or the one this same publication creates when the
 * input is materialized by this same operation; the transaction's journal decides
 * which, so a caller states only which nodes are its current direct inputs.
 */

/** @typedef {import('./graph_state').Transaction} Transaction */
/** @typedef {import('./database/node_key').NodeKey} NodeKey */
/** @typedef {import('./database/types').ComputedValue} ComputedValue */
/** @typedef {import('./database/types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./database/types').NodeKeyString} NodeKeyString */
/** @typedef {import('./journal/emission').MaterializeInput} MaterializeInput */

const { deserializeNodeKey, stringToNodeKeyString } = require("./database");
const { requireNodeKey } = require("./graph_state");

/**
 * The semantic node one persisted node key names.
 * @param {NodeKeyString} nodeKeyString
 * @returns {NodeKey}
 */
function semanticNodeOf(nodeKeyString) {
    return deserializeNodeKey(stringToNodeKeyString(String(nodeKeyString)));
}

/**
 * The current direct inputs of a node as the occurrences its certificate names.
 * @param {Transaction} tx
 * @param {NodeIdentifier[]} inputEdges - the normalized structural dependency edges, duplicates removed.
 * @returns {Promise<Array<MaterializeInput>>}
 */
async function inputOccurrencesOf(tx, inputEdges) {
    /** @type {Array<MaterializeInput>} */
    const inputs = [];
    for (const edge of inputEdges) {
        inputs.push(await tx.journal.inputOccurrence(semanticNodeOf(requireNodeKey(tx, edge))));
    }
    return inputs;
}

/**
 * Stage the materialization of a node's new value occurrence.
 * @param {Transaction} tx
 * @param {NodeKeyString} outputKey
 * @param {NodeIdentifier} nodeIdentifier
 * @param {NodeIdentifier[]} inputEdges
 * @param {ComputedValue} payload
 * @param {string} createdAt
 * @param {string} modifiedAt
 * @returns {Promise<void>}
 */
async function stageMaterialization(tx, outputKey, nodeIdentifier, inputEdges, payload, createdAt, modifiedAt) {
    const node = semanticNodeOf(outputKey);
    tx.journal.stage({
        kind: "materialize",
        node,
        nodeIdentifier,
        payload,
        createdAt,
        modifiedAt,
        inputs: await inputOccurrencesOf(tx, inputEdges),
    });
}

/**
 * Stage the revalidation of a preserved value occurrence against its current inputs.
 * @param {Transaction} tx
 * @param {NodeKeyString} outputKey
 * @param {NodeIdentifier[]} inputEdges
 * @returns {Promise<void>}
 */
async function stageRevalidation(tx, outputKey, inputEdges) {
    const node = semanticNodeOf(outputKey);
    tx.journal.stage({
        kind: "revalidate",
        node,
        value: await tx.journal.requireCommittedOccurrence(node),
        inputs: await inputOccurrencesOf(tx, inputEdges),
    });
}

/**
 * Stage the explicit invalidation of a node's incoming cache proof.
 * @param {Transaction} tx
 * @param {NodeKeyString} outputKey
 * @returns {void}
 */
function stageNodeInvalidation(tx, outputKey) {
    tx.journal.stage({ kind: "invalidate-node", node: semanticNodeOf(outputKey) });
}

/**
 * Stage the propagated staleness of the exact value occurrences of dependents whose
 * freshness the transition moved from fresh to stale.
 * @param {Transaction} tx
 * @param {NodeIdentifier[]} transitioned
 * @returns {Promise<void>}
 */
async function stageValueInvalidations(tx, transitioned) {
    for (const nodeIdentifier of transitioned) {
        const node = semanticNodeOf(requireNodeKey(tx, nodeIdentifier));
        tx.journal.stage({
            kind: "invalidate-value",
            node,
            value: await tx.journal.requireCommittedOccurrence(node),
        });
    }
}

module.exports = {
    inputOccurrencesOf,
    semanticNodeOf,
    stageMaterialization,
    stageNodeInvalidation,
    stageRevalidation,
    stageValueInvalidations,
};
