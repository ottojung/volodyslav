const {
    compareNodeIdentifier,
    nodeIdentifierToString,
    stringToNodeIdentifier,
    stringToNodeKeyString,
    deriveInputEdges,
    topologicalSortFromMap,
} = require("./database");
const { makeInvalidMigrationDecisionError } = require("./migration_errors");

/** @typedef {import('./database/types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./database/types').NodeKeyString} NodeKeyString */
/** @typedef {import('./database').ReadableSchemaStorage} ReadableSchemaStorage */
/** @typedef {import('./migration_storage').ReadableMigrationStorage} ReadableMigrationStorage */
/** @typedef {import('./migration_storage').Decision} Decision */

/**
 * Collect all materialized node keys from a parsed identifier lookup.
 * @param {import('./database/identifier_lookup').IdentifierLookup} lookup
 * @returns {NodeIdentifier[]}
 */
function loadMaterializedNodes(lookup) {
    return [...lookup.idToKey.keys()]
        .map(stringToNodeIdentifier)
        .sort(compareNodeIdentifier);
}



/**
 * Add a dependent to a validity set, maintaining deduplication.
 * @param {Map<string, Set<NodeIdentifier>>} validSets
 * @param {NodeIdentifier} input
 * @param {NodeIdentifier} dependent
 */
function addToValidSet(validSets, input, dependent) {
    const inputString = nodeIdentifierToString(input);
    const dependents = validSets.get(inputString) ?? new Set();
    dependents.add(dependent);
    validSets.set(inputString, dependents);
}

/**
 * Build the identifiers_keys_map that reflects all decisions.
 *
 * The target replica materializes the transported target keys, so a source
 * materialization the migration keeps, invalidates or replaces appears in the map
 * under `Kt = rewriteNodeKey(Ks)` rather than under the source spelling the source
 * replica persisted. A `create` declares its key in the target representation
 * already.
 *
 * @param {import('./migration_target_keys').TargetKeyView} targetKeyView - The source
 *   materialization in target NodeKey representation.
 * @param {Map<NodeIdentifier, Decision>} decisions
 * @returns {Array<[NodeIdentifier, NodeKeyString]>}
 */
function buildDecisionsMap(targetKeyView, decisions) {
    /** @type {Map<string, NodeKeyString>} */
    const idToKey = new Map();
    for (const [idString, nodeKeyJson] of targetKeyView.index.entries()) {
        const decision = decisions.get(stringToNodeIdentifier(idString));
        if (!decision || decision.kind !== "delete") {
            idToKey.set(idString, stringToNodeKeyString(nodeKeyJson));
        }
    }

    for (const [nodeKey, decision] of decisions) {
        if (decision.kind === "create" && decision.nodeKeyString !== undefined) {
            idToKey.set(nodeIdentifierToString(nodeKey), stringToNodeKeyString(decision.nodeKeyString));
        }
    }

    /** @type {Array<[NodeIdentifier, NodeKeyString]>} */
    const entries = [];
    for (const [id, key] of idToKey.entries()) {
        entries.push([stringToNodeIdentifier(id), key]);
    }
    entries.sort(([leftId], [rightId]) => compareNodeIdentifier(leftId, rightId));
    return entries;
}


/**
 * The target validity edges and the persisted freshness flag of every
 * target-present node.
 *
 * `docs/specs/incremental-graph-journal-migrations.md` §11a.4 fixes both facts and
 * requires freshness to be computed in deterministic dependency-topological order
 * after target presence and `TargetValid` are fixed. They are produced together
 * because a `create`'s up-to-date assertion is admitted exactly when its selected
 * inputs are target-fresh, and a target input's own freshness is only known once
 * that input has been settled, which is why the pass walks inputs before dependents.
 *
 * - an explicit `invalidate` is stale and asserts no positive incoming edge: §16.1
 *   makes it a genuine node-scoped invalidation rather than a certificate-selection
 *   trick;
 * - a `"potentially-outdated"` create is stale and asserts no positive incoming edge;
 * - a `"up-to-date"` create establishes full positive proof against every selected
 *   direct target input and is admitted only when every one of them is target-fresh,
 *   otherwise `InvalidMigrationDecisionError` is thrown before cutover;
 * - a replacement establishes full positive proof against every selected direct
 *   target input occurrence and is target-fresh exactly when every one of those
 *   inputs is target-fresh, otherwise it "retains full own proof but is target-stale
 *   through that input";
 * - an occurrence-preserving decision (`keep`, and a propagated invalidation) derives
 *   each carried edge from actual source proof provenance: an edge is carried only
 *   when the input's occurrence survives, the edge existed under the source scheme,
 *   and the source replica persisted it. It is target-fresh only when the source
 *   occurrence had no direct stale state which survives migration, every required
 *   target input edge is in `TargetValid`, and every target input is target-fresh.
 *   A stale occurrence keeps the unaffected proof edges its unchanged value supports;
 *   only the target's freshness flag changes, not the edge set.
 *
 * @param {ReadableMigrationStorage} prevStorage
 * @param {Map<NodeIdentifier, Decision>} decisions
 * @param {import('./database/graph_scheme').GraphScheme} oldScheme
 * @param {import('./database/graph_scheme').GraphScheme} newScheme
 * @param {import('./database/identifier_lookup').IdentifierLookup} oldLookup
 * @param {import('./database/identifier_lookup').IdentifierLookup} finalLookup
 * @returns {Promise<{
 *   desiredValid: Map<NodeIdentifier, NodeIdentifier[]>,
 *   targetFreshness: Map<NodeIdentifier, import('./database/types').Freshness>,
 * }>}
 */
async function buildTargetValidity(prevStorage, decisions, oldScheme, newScheme, oldLookup, finalLookup) {
    /** @type {Set<string>} */
    const present = new Set();
    for (const [identifier, decision] of decisions) {
        if (decision.kind !== "delete") {
            present.add(nodeIdentifierToString(identifier));
        }
    }

    /** @type {Map<NodeIdentifier, NodeIdentifier[]>} */
    const targetInputs = new Map();
    for (const [identifier, decision] of decisions) {
        if (decision.kind === "delete") {
            continue;
        }
        const edges = deriveInputEdges(newScheme, finalLookup, identifier);
        for (const edge of edges) {
            if (!present.has(nodeIdentifierToString(edge))) {
                throw makeInvalidMigrationDecisionError(
                    `Migration dependency ${nodeIdentifierToString(edge)} for ` +
                    `${nodeIdentifierToString(identifier)} is not materialized in the target replica`
                );
            }
        }
        targetInputs.set(identifier, edges);
    }

    /** @type {Map<string, Set<NodeIdentifier>>} */
    const validSets = new Map();
    /** @type {Map<NodeIdentifier, import('./database/types').Freshness>} */
    const targetFreshness = new Map();

    /** @param {import('./migration_storage').Decision | undefined} d @returns {boolean} */
    const preservesValue = (d) => d !== undefined && d.kind !== "delete" && d.kind !== "create" && d.kind !== "replace";

    const order = topologicalSortFromMap(targetInputs);
    for (const identifier of order) {
        const decision = decisions.get(identifier);
        if (decision === undefined || decision.kind === "delete") {
            continue;
        }
        const edges = targetInputs.get(identifier) ?? [];

        if (decision.kind === "invalidate" && decision.provenance === "explicit") {
            targetFreshness.set(identifier, "potentially-outdated");
            continue;
        }
        if (decision.kind === "create") {
            if (decision.freshness === "potentially-outdated") {
                targetFreshness.set(identifier, "potentially-outdated");
                continue;
            }
            for (const input of edges) {
                const inputFreshness = targetFreshness.get(input);
                if (inputFreshness !== "up-to-date") {
                    throw makeInvalidMigrationDecisionError(
                        `Cannot create ${nodeIdentifierToString(identifier)} as up-to-date: ` +
                        `input ${nodeIdentifierToString(input)} is ${inputFreshness ?? "not materialized"}`
                    );
                }
            }
            for (const input of edges) {
                addToValidSet(validSets, input, identifier);
            }
            targetFreshness.set(identifier, "up-to-date");
            continue;
        }
        if (decision.kind === "replace") {
            for (const input of edges) {
                addToValidSet(validSets, input, identifier);
            }
            let fresh = true;
            for (const input of edges) {
                if (targetFreshness.get(input) !== "up-to-date") {
                    fresh = false;
                }
            }
            targetFreshness.set(identifier, fresh ? "up-to-date" : "potentially-outdated");
            continue;
        }

        // Occurrence-preserving: `keep`, or a propagated invalidation. The source
        // occurrence survives, so the direct stale state it persisted does too.
        const sourceFreshness = await prevStorage.freshness.get(identifier);
        if (sourceFreshness === undefined) {
            throw makeInvalidMigrationDecisionError(
                `Migration transports ${nodeIdentifierToString(identifier)}, whose source replica has no freshness`
            );
        }
        const oldEdges = deriveInputEdges(oldScheme, oldLookup, identifier);
        let everyRequiredEdgeCarried = true;
        for (const input of edges) {
            let carried = false;
            if (preservesValue(decisions.get(input))) {
                const hadOldEdge = oldEdges.some(
                    (edge) => nodeIdentifierToString(edge) === nodeIdentifierToString(input)
                );
                if (hadOldEdge) {
                    const existingValidForD = await prevStorage.valid.get(input) ?? [];
                    if (existingValidForD.some(
                        (id) => nodeIdentifierToString(id) === nodeIdentifierToString(identifier)
                    )) {
                        addToValidSet(validSets, input, identifier);
                        carried = true;
                    }
                }
            }
            if (!carried) {
                everyRequiredEdgeCarried = false;
            }
        }
        let fresh = sourceFreshness === "up-to-date" && everyRequiredEdgeCarried;
        for (const input of edges) {
            if (targetFreshness.get(input) !== "up-to-date") {
                fresh = false;
            }
        }
        targetFreshness.set(identifier, fresh ? "up-to-date" : "potentially-outdated");
    }

    /** @type {Map<NodeIdentifier, NodeIdentifier[]>} */
    const desiredValid = new Map();
    for (const [inputString, dependents] of validSets) {
        desiredValid.set(stringToNodeIdentifier(inputString), [...dependents].sort(compareNodeIdentifier));
    }
    return { desiredValid, targetFreshness };
}


module.exports = {
    buildDecisionsMap,
    buildTargetValidity,
    loadMaterializedNodes,
};
