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
 * One committed validity proof a clearing transaction withdrew, together with the
 * dependency whose validity set held it.
 *
 * The properties that this class carries are:
 * - `dependent` was in the committed `valid[dependency]` before the clearing
 *   transaction published and is not in it afterwards.
 * - `dependency` is the node whose value occurrence that publication superseded,
 *   so `dependent`'s stored value was computed against an occurrence of
 *   `dependency` which no longer exists.
 *
 * The proof of those properties is guaranteed by:
 * - This class can only be introduced through this function:
 *   - `resolveValidMutations(depId, committed, mutations)`: satisfies the property
 *     because it emits one for each member of `committed` absent from the resolved
 *     set, and only when `mutations` contains a `clear`, and it pairs the member
 *     with the dependency whose `committed` set held it.
 */
class WithdrawnProof {
    /**
     * @param {NodeIdentifier} dependency
     * @param {NodeIdentifier} dependent
     */
    constructor(dependency, dependent) {
        this.dependency = dependency;
        this.dependent = dependent;
    }
}

/**
 * The properties that this class carries are:
 * - `validSet` is `committed` with the recorded mutations applied, canonically sorted.
 * - `withdrawn` names exactly the committed dependents a `clear` in these mutations
 *   withdrew, each paired with the dependency whose validity set held it.
 *
 * The proof of those properties is guaranteed by:
 * - This class can only be introduced through these functions:
 *   - `resolveValidMutations(depId, committed, mutations)`: satisfies the property
 *     because it computes `validSet` as `applyValidMutations(committed, mutations)`
 *     and `withdrawn` as the members of `committed` absent from that set, adding to
 *     it only when `mutations` contains a `clear`.
 */
class ResolvedValidMutations {
    /**
     * @param {NodeIdentifier[]} validSet - The resolved validity set, canonically sorted.
     * @param {WithdrawnProof[]} withdrawn - The committed dependents a clear withdrew.
     */
    constructor(validSet, withdrawn) {
        this.validSet = validSet;
        this.withdrawn = withdrawn;
    }
}

/**
 * Resolve one dependency's recorded validity mutations against its committed set.
 * @param {NodeIdentifier} depId
 * @param {NodeIdentifier[]} committed
 * @param {Array<ValidMutation | ValidClearMutation>} mutations
 * @returns {ResolvedValidMutations}
 */
function resolveValidMutations(depId, committed, mutations) {
    const validSet = applyValidMutations(committed, mutations);
    const hasClear = mutations.some(m => m.kind === "clear");
    if (!hasClear) {
        return new ResolvedValidMutations(validSet, []);
    }
    const retained = new Set(validSet.map(id => nodeIdentifierToString(id)));
    const withdrawn = committed
        .filter(id => !retained.has(nodeIdentifierToString(id)))
        .map(id => new WithdrawnProof(depId, id));
    withdrawn.sort((a, b) => compareNodeIdentifier(a.dependent, b.dependent));
    return new ResolvedValidMutations(validSet, withdrawn);
}

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
 * against an occurrence which no longer exists.
 *
 * The withdrawal is deliberately conservative: a withdrawn proof costs a
 * recomputation, a surviving false proof costs a wrong answer. The residual
 * cost this conservatism leaves is that two transactions which both
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
 * `resolveValidMutations` reports the withdrawn dependents alongside the
 * resolved set, because a withdrawal is not complete until the withdrawal is
 * published as staleness: `handleChanged` propagates staleness over the set this
 * transaction read, which by the premise of the interleaving need not contain a
 * committed dependent the clear withdraws. The commit seam propagates over the
 * withdrawn set as well, so every dependent left without a proof is also left
 * without a claim to be up to date.
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
 * the resulting put/del operations into the shared operations array, reporting
 * every committed dependent a `clear` withdrew.
 * Used by both withTransaction() and withBatch().
 *
 * The withdrawn set is reported because the caller must publish the withdrawal
 * as staleness: a dependent whose proof this transaction withdrew is one whose
 * value was computed against a value occurrence of the dependency which this
 * transaction is superseding, so leaving it `up-to-date` would let the pull fast
 * path serve it a value of a value that no longer exists.
 *
 * @param {SchemaStorage} activeSchemaStorage
 * @param {Array<*>} operations
 * @param {Map<string, Array<ValidMutation | ValidClearMutation>>} validMutations
 * @returns {Promise<Array<WithdrawnProof>>} The committed proofs the clears withdrew.
 */
async function appendValidMutationOps(activeSchemaStorage, operations, validMutations) {
    if (validMutations.size === 0) {
        return [];
    }
    /** @type {Array<WithdrawnProof>} */
    const withdrawn = [];
    for (const [depIdStr, mutations] of validMutations.entries()) {
        const depId = nodeIdentifierFromString(depIdStr);
        const committed = await activeSchemaStorage.valid.get(depId) ?? [];
        const resolved = resolveValidMutations(depId, committed, mutations);
        if (resolved.validSet.length === 0) {
            operations.push(activeSchemaStorage.valid.delOp(depId));
        } else {
            operations.push(activeSchemaStorage.valid.putOp(depId, resolved.validSet));
        }
        withdrawn.push(...resolved.withdrawn);
    }
    return withdrawn;
}


module.exports = {
    ResolvedValidMutations,
    WithdrawnProof,
    appendValidMutationOps,
    applyValidMutations,
    resolveValidMutations,
};
