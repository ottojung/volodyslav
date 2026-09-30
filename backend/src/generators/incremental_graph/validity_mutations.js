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
 * return the sorted result. The returned array is always freshly allocated, so
 * a storage-owned array is never sorted in place by a reader.
 *
 * A `clear` empties the set. It withdraws every committed dependent, not only
 * the ones the transaction read, and that is the only sound scope available
 * while `valid[D]` carries no occurrence tag. A dependent which survives a
 * clear is a positive assertion that the dependent was computed against the
 * value occurrence of `D` the clearing transaction publishes, and the clearing
 * transaction is publishing a value it computed after every read the surviving
 * transaction could have made. Scoping the withdrawal to the dependents the
 * clearing transaction happened to read leaves surviving proofs standing
 * against an occurrence which no longer exists, and the pull path
 * (`recompute.js`, `internalMaybeRecalculate`) decides cache revalidation from
 * `valid[D].has(N)` membership alone, so such a proof is served from cache and
 * a dependent returns the value it computed from the superseded occurrence.
 *
 * The withdrawal is deliberately conservative: a withdrawn proof costs a
 * recomputation, a surviving false proof costs a wrong answer. The residual
 * defect this conservatism leaves is that two transactions which both
 * re-materialise one dependency each withdraw the other's frontier, so the
 * second to commit leaves a dependent which must recompute although its proof
 * was sound. The rule which is both sound and free of that cost is
 * occurrence-scoped withdrawal: withdraw every dependent whose proof is not
 * against the value occurrence of `D` this transaction commits. Implementing it
 * requires `valid[D]` to record, per dependent, the occurrence it was
 * established against, which changes the serialised form of `valid[D]` from an
 * array of `NodeIdentifier` and therefore needs a storage migration and a
 * change to `docs/specs/incremental-graph-flag-based-inverse-validity.md`.
 *
 * A narrower scope would be sound only if no computor could yield different
 * content on two materialisations of the same node. The `isDeterministic` and
 * `hasSideEffects` flags on a node definition are validated and documented
 * (`types.js`, `compiled_node_validation.js`) but are read nowhere in the
 * recompute or validity path, so nothing here may assume them.
 *
 * @param {NodeIdentifier[]} committed
 * @param {Array<ValidMutation | ValidClearMutation>} mutations
 * @returns {NodeIdentifier[]}
 */
function applyValidMutations(committed, mutations) {
    let validSet = committed.slice();
    for (const m of mutations) {
        if (m.kind === "clear") {
            validSet = [];
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
