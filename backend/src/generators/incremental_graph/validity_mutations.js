/**
 * Validity mutations resolved at the commit seam.
 *
 * A graph transaction records which validity edges it adds and removes rather than
 * rewriting whole `valid[D]` arrays, so two transactions which touch overlapping
 * validity sets cannot lose each other's updates. This module is the other half of
 * that: it resolves the recorded mutations against the latest committed state, under
 * the lock which serialises publication, and contributes the resulting put and delete
 * operations to the very batch that publishes the transaction.
 *
 * The operations land in the same atomic write as the transaction's other mutations
 * and as the Journal records of the transition they belong to, so a resolved validity
 * set is never durable without the records that explain it.
 */

/** @typedef {import('./database/root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./database/types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./graph_state').ValidMutation} ValidMutation */
/** @typedef {import('./graph_state').ValidClearMutation} ValidClearMutation */

const { compareNodeIdentifier, nodeIdentifierFromString, nodeIdentifierToString } = require('./database');

/**
 * Apply a transaction's recorded validity mutations to a validity set and
 * return the sorted result.
 *
 * A `clear` withdraws exactly the dependents the transaction observed in the set
 * it clears, and preserves every other committed dependent. Without that
 * restriction a clear resolved against committed state erases edges which other
 * transactions established after this transaction read the set: two transactions
 * which both materialise a shared dependency each record a clear for that
 * dependency's outgoing set, and the second clear would drop the first
 * transaction's dependent. A clear recorded without an observation replaces the
 * set wholesale.
 *
 * @param {NodeIdentifier[]} committed
 * @param {Array<ValidMutation | ValidClearMutation>} mutations
 * @returns {NodeIdentifier[]}
 */
function applyValidMutations(committed, mutations) {
    let validSet = committed;
    for (const m of mutations) {
        if (m.kind === "clear") {
            if (m.observed === undefined) {
                validSet = [];
                continue;
            }
            const observed = m.observed.map(nodeIdentifierToString);
            validSet = validSet.filter(id => !observed.includes(nodeIdentifierToString(id)));
        } else if (m.kind === "add") {
            const depStr = nodeIdentifierToString(m.dependent);
            if (!validSet.some(id => nodeIdentifierToString(id) === depStr)) {
                validSet = validSet.concat([m.dependent]);
            }
        } else if (m.kind === "remove") {
            const depStr = nodeIdentifierToString(m.dependent);
            validSet = validSet.filter(id => nodeIdentifierToString(id) !== depStr);
        }
    }
    return validSet.sort(compareNodeIdentifier);
}

/**
 * Apply recorded validity mutations to the latest committed state and push
 * the resulting put/del operations into the shared operations array.
 * Used by both withTransaction() and withBatch().
 *
 * @param {SchemaStorage} activeSchemaStorage
 * @param {Array<*>} operations
 * @param {Map<string, Array<ValidMutation | ValidClearMutation>>} validMutations
 * @returns {Promise<void>}
 */
async function appendValidMutationOps(activeSchemaStorage, operations, validMutations) {
    if (validMutations.size === 0) {
        return;
    }
    for (const [depIdStr, mutations] of validMutations.entries()) {
        const depId = nodeIdentifierFromString(depIdStr);
        const committed = await activeSchemaStorage.valid.get(depId) ?? [];
        const validSet = applyValidMutations(committed, mutations);
        if (validSet.length === 0) {
            operations.push(activeSchemaStorage.valid.delOp(depId));
        } else {
            operations.push(activeSchemaStorage.valid.putOp(depId, validSet));
        }
    }
}


module.exports = {
    appendValidMutationOps,
    applyValidMutations,
};
