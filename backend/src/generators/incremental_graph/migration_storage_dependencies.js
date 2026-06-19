/**
 * Dependency propagation helpers for MigrationStorage.
 */

const {
    nodeIdentifierToString,
    deriveInputEdges,
} = require("./database");
const {
    makeDecisionConflictError,
    makePartialDeleteFanInError,
} = require("./migration_errors");
const {
    checkSchemaCompatibility,
} = require("./migration_storage_schema");

/** @typedef {import('./database/types').ComputedValue} ComputedValue */
/** @typedef {import('./database/types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./types').CompiledNode} CompiledNode */
/** @typedef {import('./types').NodeName} NodeName */
/** @typedef {import('./migration_storage').ReadableMigrationStorage} ReadableMigrationStorage */

/**
 * @typedef {{ kind: 'keep' }} KeepDecision
 * @typedef {{ kind: 'override', value: (nodeKey: NodeIdentifier) => Promise<ComputedValue> }} OverrideDecision
 * @typedef {{ kind: 'invalidate' }} InvalidateDecision
 * @typedef {{ kind: 'delete' }} DeleteDecision
 * @typedef {{ kind: 'create', nodeKeyString: string, value: (nodeKey: NodeIdentifier) => Promise<ComputedValue> }} CreateDecision
 * @typedef {KeepDecision | OverrideDecision | InvalidateDecision | DeleteDecision | CreateDecision} Decision
 */

/**
 * Reads the validity-authorized consumers for a node from the previous storage.
 * @param {NodeIdentifier} nodeKey
 * @param {ReadableMigrationStorage} prevStorage
 * @returns {Promise<NodeIdentifier[]>}
 */
async function readValidDependents(nodeKey, prevStorage) {
    const dependents = await prevStorage.valid.get(nodeKey);
    return dependents !== undefined ? dependents : [];
}

/**
 * Recursively propagate INVALIDATE through the validity sets of a node.
 * @param {object} ctx
 * @param {NodeIdentifier} ctx.nodeKey
 * @param {Set<NodeIdentifier>} ctx.visited
 * @param {ReadableMigrationStorage} ctx.prevStorage
 * @param {Set<NodeIdentifier>} ctx.materializedNodes
 * @param {Map<NodeIdentifier, Decision>} ctx.decisions
 * @param {Map<NodeName, CompiledNode>} ctx.newHeadIndex
 * @param {() => Promise<Map<string, string>>} ctx.getIdentifiersKeysIndex
 * @returns {Promise<void>}
 */
async function propagateInvalidate(ctx) {
    const { nodeKey, visited, prevStorage, materializedNodes, decisions, newHeadIndex, getIdentifiersKeysIndex } = ctx;
    if (visited.has(nodeKey)) return;
    visited.add(nodeKey);
    const dependents = await readValidDependents(nodeKey, prevStorage);
    for (const dep of dependents) {
        if (!materializedNodes.has(dep)) continue;
        const existing = decisions.get(dep);
        if (existing !== undefined) {
            if (existing.kind === "delete" || existing.kind === "invalidate") {
                continue;
            }
            throw makeDecisionConflictError(dep, existing.kind, "invalidate");
        }
        const identifiersKeysIndex = await getIdentifiersKeysIndex();
        await checkSchemaCompatibility(dep, newHeadIndex, identifiersKeysIndex, decisions);
        decisions.set(dep, { kind: "invalidate" });
        await propagateInvalidate({
            nodeKey: dep,
            visited,
            prevStorage,
            materializedNodes,
            decisions,
            newHeadIndex,
            getIdentifiersKeysIndex,
        });
    }
}

/**
 * Build a structural dependency map by deriving dependency edges for every
 * materialized node from the stored graph scheme and identifier lookup.
 * The `valid` relation is an authorization frontier, not a complete
 * structural dependency graph.
 * @param {Set<NodeIdentifier>} materializedNodes
 * @param {import('./database/graph_scheme').GraphScheme} oldGraphScheme
 * @param {import('./database/identifier_lookup').IdentifierLookup} oldLookup
 * @returns {Promise<Map<string, Set<NodeIdentifier>>>}
 */
async function buildStructuralDependents(materializedNodes, oldGraphScheme, oldLookup) {
    const map = new Map();
    for (const nodeKey of materializedNodes) {
        const record = deriveInputEdges(oldGraphScheme, oldLookup, nodeKey);
        for (const input of record) {
            const inputStr = nodeIdentifierToString(input);
            const deps = map.get(inputStr) ?? new Set();
            deps.add(nodeKey);
            map.set(inputStr, deps);
        }
    }
    return map;
}

/**
 * BFS propagation of DELETE to dependents whose all inputs are deleted,
 * followed by a fan-in violation scan.
 *
 * Uses scheme-derived structural dependencies rather than valid so that
 * stale nodes whose dependents are absent from valid are still discovered.
 * @param {object} ctx
 * @param {Set<NodeIdentifier>} ctx.materializedNodes
 * @param {Map<NodeIdentifier, Decision>} ctx.decisions
 * @param {import('./database/graph_scheme').GraphScheme} ctx.oldGraphScheme
 * @param {import('./database/identifier_lookup').IdentifierLookup} ctx.oldLookup
 * @returns {Promise<void>}
 */
async function propagateDeletesAndCheckFanIn(ctx) {
    const { materializedNodes, decisions, oldGraphScheme, oldLookup } = ctx;
    const structuralDependents = await buildStructuralDependents(materializedNodes, oldGraphScheme, oldLookup);
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
            if (!materializedNodes.has(dep)) continue;
            if (decisions.get(dep)?.kind === "delete") continue;
            const depRecord = deriveInputEdges(oldGraphScheme, oldLookup, dep);
            const allDeleted = depRecord.every(
                (inp) => decisions.get(inp)?.kind === "delete"
            );
            if (!allDeleted) continue;
            const existing = decisions.get(dep);
            if (existing !== undefined) {
                throw makeDecisionConflictError(dep, existing.kind, "delete");
            }
            decisions.set(dep, { kind: "delete" });
            queue.push(dep);
        }
    }
    // Fan-in violation: any non-deleted node reachable from a deleted node
    // that was not itself auto-deleted means its inputs are only partially deleted.
    for (const [nodeKey, decision] of decisions) {
        if (decision.kind !== "delete") continue;
        const nodeKeyStr = nodeIdentifierToString(nodeKey);
        const dependents = structuralDependents.get(nodeKeyStr);
        if (dependents === undefined) continue;
        for (const dep of dependents) {
            if (!materializedNodes.has(dep)) continue;
            if (decisions.get(dep)?.kind === "delete") continue;
            const depRecord = deriveInputEdges(oldGraphScheme, oldLookup, dep);
            throw makePartialDeleteFanInError(dep, depRecord);
        }
    }
}

module.exports = {
    readValidDependents,
    propagateInvalidate,
    buildStructuralDependents,
    propagateDeletesAndCheckFanIn,
};
