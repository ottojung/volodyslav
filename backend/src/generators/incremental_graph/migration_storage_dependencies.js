/**
 * Dependency propagation helpers for MigrationStorage.
 */

const {
    nodeIdentifierToString,
    deriveInputEdges,
    makeIdentifierLookup,
    stringToNodeKeyString,
    GraphSchemeError,
} = require("./database");
const {
    makeDecisionConflictError,
    makeInvalidMigrationDecisionError,
} = require("./migration_errors");
const {
    checkSchemaCompatibility,
} = require("./migration_storage_schema");

/** @typedef {import('./database/types').ComputedValue} ComputedValue */
/** @typedef {import('./database/types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./types').CompiledNode} CompiledNode */
/** @typedef {import('./types').NodeName} NodeName */
/** @typedef {import('./migration_storage').ReadableMigrationStorage} ReadableMigrationStorage */

/** @typedef {import('./migration_decisions').KeepDecision} KeepDecision */
/** @typedef {import('./migration_decisions').OverrideDecision} OverrideDecision */
/** @typedef {import('./migration_decisions').InvalidateDecision} InvalidateDecision */
/** @typedef {import('./migration_decisions').DeleteDecision} DeleteDecision */
/** @typedef {import('./migration_decisions').CreatedFreshness} CreatedFreshness */
/** @typedef {import('./migration_decisions').CreateDecision} CreateDecision */
/** @typedef {import('./migration_decisions').Decision} Decision */

/**
 * Reads the outgoing validity frontier for a node from the previous storage.
 * @param {NodeIdentifier} nodeKey
 * @param {ReadableMigrationStorage} prevStorage
 * @returns {Promise<NodeIdentifier[]>}
 */
async function readValidDependents(nodeKey, prevStorage) {
    const dependents = await prevStorage.valid.get(nodeKey);
    return dependents !== undefined ? dependents : [];
}

/**
 * Propagate INVALIDATE through previous validity edges.
 *
 * Recursive invalidation propagates freshness only — it does not remove
 * validity edges. Each reached dependent is marked as a propagated
 * invalidation, and the traversal continues through its outgoing validity
 * frontier. A node-level visited set is sufficient; there is no need to
 * track causal predecessors because no validity edges are revoked.
 * @param {object} ctx
 * @param {NodeIdentifier} ctx.nodeKey
 * @param {Set<NodeIdentifier>} ctx.visited
 * @param {ReadableMigrationStorage} ctx.prevStorage
 * @param {Set<NodeIdentifier>} ctx.materializedNodes
 * @param {Map<NodeIdentifier, Decision>} ctx.decisions
 * @param {Map<NodeName, CompiledNode>} ctx.newHeadIndex
 * @param {() => Map<string, string>} ctx.getIdentifiersKeysIndex
 * @returns {Promise<void>}
 */
async function propagateInvalidate(ctx) {
    const { nodeKey, visited, prevStorage, materializedNodes, decisions, newHeadIndex, getIdentifiersKeysIndex } = ctx;
    /** @type {NodeIdentifier[]} */
    const worklist = [nodeKey];

    while (worklist.length > 0) {
        const current = worklist.pop();
        if (current === undefined) continue;
        if (visited.has(current)) continue;
        visited.add(current);

        const dependents = await readValidDependents(current, prevStorage);
        for (const dep of dependents) {
            if (!materializedNodes.has(dep)) continue;
            const existing = decisions.get(dep);
            if (existing !== undefined) {
                if (existing.kind === "delete") {
                    continue;
                }
                if (existing.kind === "invalidate") {
                    if (!visited.has(dep)) {
                        worklist.push(dep);
                    }
                    continue;
                }
                throw makeDecisionConflictError(dep, existing.kind, "invalidate");
            }
            const identifiersKeysIndex = getIdentifiersKeysIndex();
            await checkSchemaCompatibility(dep, newHeadIndex, identifiersKeysIndex, decisions);
            decisions.set(dep, { kind: "invalidate", provenance: "propagated" });
            if (!visited.has(dep)) {
                worklist.push(dep);
            }
        }
    }
}

/**
 * BFS propagation of DELETE to every materialized structural dependent.
 *
 * Uses scheme-derived structural dependencies rather than valid so that
 * stale nodes whose dependents are absent from valid are still discovered.
 * @param {object} ctx
 * @param {Set<NodeIdentifier>} ctx.materializedNodes
 * @param {Map<NodeIdentifier, Decision>} ctx.decisions
 * @param {import('./database/graph_scheme').GraphScheme} ctx.newGraphScheme
 * @param {import('./database/identifier_lookup').IdentifierLookup} ctx.oldLookup
 * @returns {Promise<void>}
 */
async function propagateDeletes(ctx) {
    const { materializedNodes, decisions, newGraphScheme, oldLookup } = ctx;
    /** @type {Array<[NodeIdentifier, import('./database/types').NodeKeyString]>} */
    const candidateEntries = [];
    for (const nodeKey of materializedNodes) {
        const semanticKey = oldLookup.idToKey.get(nodeIdentifierToString(nodeKey));
        if (semanticKey !== undefined) {
            candidateEntries.push([nodeKey, semanticKey]);
        }
    }
    for (const [nodeKey, decision] of decisions) {
        if (decision.kind === "create") {
            candidateEntries.push([nodeKey, stringToNodeKeyString(decision.nodeKeyString)]);
        }
    }
    const candidateLookup = makeIdentifierLookup(candidateEntries);

    /** @type {NodeIdentifier[]} */
    const targetGraphNodes = [];
    for (const nodeKey of materializedNodes) {
        if (decisions.get(nodeKey)?.kind === "delete") continue;
        targetGraphNodes.push(nodeKey);
    }
    for (const [nodeKey, decision] of decisions) {
        if (decision.kind === "create") {
            targetGraphNodes.push(nodeKey);
        }
    }

    /** @type {Map<string, Set<NodeIdentifier>>} */
    const structuralDependents = new Map();
    for (const nodeKey of targetGraphNodes) {
        let record;
        try {
            record = deriveInputEdges(newGraphScheme, candidateLookup, nodeKey);
        } catch (error) {
            if (error instanceof GraphSchemeError) {
                throw makeInvalidMigrationDecisionError(error.message);
            }
            throw error;
        }
        for (const input of record) {
            const inputStr = nodeIdentifierToString(input);
            const deps = structuralDependents.get(inputStr) ?? new Set();
            deps.add(nodeKey);
            structuralDependents.set(inputStr, deps);
        }
    }

    const queue = [];
    for (const [nodeKey, decision] of decisions) {
        if (decision.kind === "delete") {
            queue.push(nodeKey);
        }
    }
    let head = 0;
    while (head < queue.length) {
        const nodeKey = queue[head];
        head++;
        if (nodeKey === undefined) break;
        const nodeKeyStr = nodeIdentifierToString(nodeKey);
        const dependents = structuralDependents.get(nodeKeyStr);
        if (dependents === undefined) continue;
        for (const dep of dependents) {
            const existing = decisions.get(dep);
            if (existing?.kind === "delete") continue;
            if (existing !== undefined) {
                if (existing.kind === "invalidate" && existing.provenance === "propagated") {
                    decisions.set(dep, { kind: "delete" });
                    queue.push(dep);
                    continue;
                }
                throw makeDecisionConflictError(dep, existing.kind, "delete");
            }
            if (!materializedNodes.has(dep)) {
                throw makeDecisionConflictError(dep, "create", "delete");
            }
            decisions.set(dep, { kind: "delete" });
            queue.push(dep);
        }
    }
}




module.exports = {
    readValidDependents,
    propagateInvalidate,
    propagateDeletes,
};
