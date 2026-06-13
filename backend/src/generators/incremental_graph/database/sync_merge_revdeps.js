const { stringToNodeIdentifier, nodeIdentifierToString } = require('./types');
const { compareNodeIdentifier } = require('./node_identifier');
const { RAW_BATCH_CHUNK_SIZE } = require('./constants');

/** @typedef {import('./root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */

/**
 * Gently update the revdeps index in `T` to match the desired state derived
 * from `mergedInputsMap`.
 *
 * @param {SchemaStorage} T
 * @param {Map<NodeIdentifier, NodeIdentifier[]>} mergedInputsMap
 * @returns {Promise<void>}
 */
async function unifyRevdeps(T, mergedInputsMap) {
    /** @type {Map<string, Set<NodeIdentifier>>} */
    const desiredSets = new Map();

    for (const [node, inputKeys] of mergedInputsMap) {
        for (const inputKey of inputKeys) {
            const inputStr = nodeIdentifierToString(inputKey);
            const existing = desiredSets.get(inputStr);
            if (existing) {
                existing.add(node);
            } else {
                desiredSets.set(inputStr, new Set([node]));
            }
        }
    }

    /** @type {Map<string, NodeIdentifier[]>} */
    const desired = new Map();
    for (const [key, depSet] of desiredSets) {
        desired.set(key, [...depSet].sort(compareNodeIdentifier));
    }

    /** @type {Set<string>} */
    const targetKeys = new Set();
    for await (const key of T.revdeps.keys()) {
        targetKeys.add(nodeIdentifierToString(key));
    }

    /** @type {Array<*>} */
    const ops = [];
    for (const [inputStr, dependents] of desired) {
        const inputKey = stringToNodeIdentifier(inputStr);
        if (!targetKeys.has(inputStr)) {
            ops.push(T.revdeps.putOp(inputKey, dependents));
        } else {
            const existing = await T.revdeps.get(inputKey);
            if (JSON.stringify(existing) !== JSON.stringify(dependents)) {
                ops.push(T.revdeps.putOp(inputKey, dependents));
            }
        }
        if (ops.length >= RAW_BATCH_CHUNK_SIZE) {
            await T.batch(ops.splice(0, ops.length));
        }
    }

    for (const existingKey of targetKeys) {
        if (!desired.has(existingKey)) {
            ops.push(T.revdeps.delOp(stringToNodeIdentifier(existingKey)));
        }
        if (ops.length >= RAW_BATCH_CHUNK_SIZE) {
            await T.batch(ops.splice(0, ops.length));
        }
    }

    if (ops.length > 0) {
        await T.batch(ops);
    }
}

module.exports = {
    unifyRevdeps,
};
