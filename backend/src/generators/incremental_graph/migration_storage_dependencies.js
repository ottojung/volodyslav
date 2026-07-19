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

/**
 * @typedef {{ kind: 'keep' }} KeepDecision
 * @typedef {{ kind: 'override', value: (nodeKey: NodeIdentifier) => Promise<ComputedValue> }} OverrideDecision
 * @typedef {{ kind: 'invalidate' }} InvalidateDecision
 * @typedef {{ kind: 'delete' }} DeleteDecision
 * @typedef {"up-to-date" | "potentially-outdated"} CreatedFreshness
 * @typedef {{ kind: 'create', nodeKeyString: string, value: (nodeKey: NodeIdentifier) => Promise<ComputedValue>, freshness: CreatedFreshness }} CreateDecision
 * @typedef {KeepDecision | OverrideDecision | InvalidateDecision | DeleteDecision | CreateDecision} Decision
 */

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
 * The `valid` relation is a stale-cache proof and invalidation frontier,
 * not a complete structural dependency graph.
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
                const decision = decisions.get(nodeKey);
                if (decision?.kind === 'create') continue;
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
    buildStructuralDependents,
    propagateDeletes,
};
