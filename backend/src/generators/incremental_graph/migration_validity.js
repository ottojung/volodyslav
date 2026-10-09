const {
    compareNodeIdentifier,
    nodeIdentifierToString,
    nodeKeyStringToString,
    stringToNodeIdentifier,
    stringToNodeKeyString,
    deriveInputEdges,
    deriveInputPositions,
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
 * @param {Map<NodeIdentifier, Decision>} decisions
 * @returns {Set<string>}
 */
function materializedDecisionStrings(decisions) {
    const result = new Set();
    for (const [identifier, decision] of decisions) {
        if (decision.kind !== "delete") {
            result.add(nodeIdentifierToString(identifier));
        }
    }
    return result;
}

/**
 * The persisted freshness flag every target-present node carries.
 *
 * `docs/specs/incremental-graph-journal-migrations.md` §11a.4 derives each
 * decision family's target freshness, and computes it in deterministic
 * dependency-topological order after target presence and `TargetValid` are fixed:
 *
 * - an explicit `invalidate` is stale, and a `"potentially-outdated"` create is
 *   stale, because each of them asserts that the occurrence it authors is not
 *   known to reflect its inputs;
 * - a replacement establishes full positive proof against every selected direct
 *   target input, so its own flag is up-to-date exactly when every one of those
 *   inputs is target-fresh, and is a stale flag otherwise. §11a.4 states that a
 *   replacement whose input is stale "retains full own proof but is target-stale
 *   through that input";
 * - an occurrence-preserving decision transports the source occurrence and the
 *   direct stale state the source persisted for it, so its flag is the source
 *   replica's. A target-stale *input* of such a node is not written into its own
 *   flag: replay derives that node's staleness from the input, and a proof edge
 *   whose basis no longer names the selected input occurrence makes it hard
 *   stale, which `buildDesiredValid` already encodes by not carrying that edge.
 *
 * @param {ReadableMigrationStorage} prevStorage
 * @param {Map<NodeIdentifier, Decision>} decisions
 * @param {import('./database/graph_scheme').GraphScheme} newGraphScheme
 * @param {import('./database/identifier_lookup').IdentifierLookup} finalLookup
 * @returns {Promise<Map<NodeIdentifier, import('./database/types').Freshness>>}
 */
async function buildTargetFreshness(prevStorage, decisions, newGraphScheme, finalLookup) {
    /** @type {Map<NodeIdentifier, import('./database/types').Freshness>} */
    const targetFreshness = new Map();

    /**
     * @param {NodeIdentifier} nodeIdentifier
     * @returns {Promise<import('./database/types').Freshness>}
     */
    async function freshnessOf(nodeIdentifier) {
        const settled = targetFreshness.get(nodeIdentifier);
        if (settled !== undefined) {
            return settled;
        }
        const decision = decisions.get(nodeIdentifier);
        if (decision === undefined || decision.kind === "delete") {
            throw makeInvalidMigrationDecisionError(
                `Migration target freshness asks about ${nodeIdentifierToString(nodeIdentifier)}, which the target does not materialize`
            );
        }
        if (decision.kind === "invalidate") {
            targetFreshness.set(nodeIdentifier, "potentially-outdated");
            return "potentially-outdated";
        }
        if (decision.kind === "create") {
            targetFreshness.set(nodeIdentifier, decision.freshness);
            return decision.freshness;
        }
        const nodeKeyString = finalLookup.idToKey.get(nodeIdentifierToString(nodeIdentifier));
        if (nodeKeyString === undefined) {
            throw makeInvalidMigrationDecisionError(
                `Migration target freshness asks about ${nodeIdentifierToString(nodeIdentifier)}, which the target lookup does not name`
            );
        }
        if (decision.kind !== "replace") {
            const transported = await prevStorage.freshness.get(nodeIdentifier);
            if (transported === undefined) {
                throw makeInvalidMigrationDecisionError(
                    `Migration transports ${nodeIdentifierToString(nodeIdentifier)}, whose source replica has no freshness`
                );
            }
            targetFreshness.set(nodeIdentifier, transported);
            return transported;
        }
        let fresh = true;
        for (const inputKey of deriveInputPositions(newGraphScheme, nodeKeyString)) {
            const input = finalLookup.keyToId.get(nodeKeyStringToString(inputKey));
            if (input === undefined) {
                throw makeInvalidMigrationDecisionError(
                    `Migration replaced ${nodeIdentifierToString(nodeIdentifier)} against input ` +
                    `${nodeKeyStringToString(inputKey)}, which the target does not materialize`
                );
            }
            if (await freshnessOf(input) !== "up-to-date") {
                fresh = false;
            }
        }
        const freshness = fresh ? "up-to-date" : "potentially-outdated";
        targetFreshness.set(nodeIdentifier, freshness);
        return freshness;
    }

    for (const [identifier, decision] of decisions) {
        if (decision.kind === "delete") {
            continue;
        }
        await freshnessOf(identifier);
    }
    return targetFreshness;
}

/**
 * @param {ReadableMigrationStorage} _prevStorage
 * @param {Map<NodeIdentifier, Decision>} decisions
 * @param {NodeIdentifier} nodeIdentifier
 * @returns {Promise<boolean>}
 */
async function isFinalCached(_prevStorage, decisions, nodeIdentifier) {
    const decision = decisions.get(nodeIdentifier);
    return decision !== undefined && decision.kind !== "delete";
}

/**
 * Build validity sets from migration decisions and scheme-derived final edges.
 *
 * §11a.4 derives `TargetValid` per decision family. An occurrence-preserving
 * decision derives its edges from actual source proof provenance: an edge is
 * carried only when the input's occurrence survives, the edge existed under the
 * source scheme, and the source replica persisted it. A replacement instead
 * establishes full positive proof against every selected direct target input
 * occurrence, because the migration produced that occurrence at the cut with the
 * supplied value.
 *
 * @param {ReadableMigrationStorage} prevStorage
 * @param {Map<NodeIdentifier, Decision>} decisions
 * @param {import('./database/graph_scheme').GraphScheme} oldScheme
 * @param {import('./database/graph_scheme').GraphScheme} newScheme
 * @param {import('./database/identifier_lookup').IdentifierLookup} oldLookup
 * @param {import('./database/identifier_lookup').IdentifierLookup} finalLookup
 * @param {ReadonlyMap<NodeIdentifier, import('./database/types').Freshness>} targetFreshness - The §11a.4
 *   freshness flag of every target-present node, which is what a `create`'s
 *   assertion and a replacement's own flag are read from.
 * @returns {Promise<Map<NodeIdentifier, NodeIdentifier[]>>}
 */
async function buildDesiredValid(prevStorage, decisions, oldScheme, newScheme, oldLookup, finalLookup, targetFreshness) {
    /** @type {Map<string, Set<NodeIdentifier>>} */
    const validSets = new Map();
    const materialized = materializedDecisionStrings(decisions);

    for (const [nodeIdentifier, decision] of decisions) {
        if (decision.kind === "delete" || (decision.kind === "invalidate" && decision.provenance === "explicit")) continue;
        if (!await isFinalCached(prevStorage, decisions, nodeIdentifier)) continue;

        const finalEdges = deriveInputEdges(newScheme, finalLookup, nodeIdentifier);
        for (const edge of finalEdges) {
            if (!materialized.has(nodeIdentifierToString(edge))) {
                throw makeInvalidMigrationDecisionError(`Migration dependency ${nodeIdentifierToString(edge)} for ${nodeIdentifierToString(nodeIdentifier)} is not materialized in the target replica`);
            }
        }

        if (decision.kind === "create") {
            if (decision.freshness === "potentially-outdated") continue;
            for (const input of finalEdges) {
                if (!await isFinalCached(prevStorage, decisions, input)) {
                    throw makeInvalidMigrationDecisionError(`Cannot create ${nodeIdentifierToString(nodeIdentifier)} as up-to-date: input ${nodeIdentifierToString(input)} is not cached`);
                }
                const inputFreshness = targetFreshness.get(input);
                if (inputFreshness !== "up-to-date") {
                    throw makeInvalidMigrationDecisionError(`Cannot create ${nodeIdentifierToString(nodeIdentifier)} as up-to-date: input ${nodeIdentifierToString(input)} is ${inputFreshness ?? "not materialized"}`);
                }
                addToValidSet(validSets, input, nodeIdentifier);
            }
            continue;
        }

        // A replacement establishes full positive proof against every selected
        // direct target input occurrence. §11a.4 allows no precondition on those
        // inputs: a stale input leaves the replacement's own flag stale while its
        // own proof stays complete.
        if (decision.kind === "replace") {
            for (const input of finalEdges) {
                addToValidSet(validSets, input, nodeIdentifier);
            }
            continue;
        }

        // Preserve old outgoing proofs when the input's stored semantic value
        // survives — this applies to keep and to propagated invalidations
        // (invalidation changes freshness, not value). Delete nodes have no
        // surviving value; create and replace nodes author a new occurrence, so
        // an old proof naming the replaced occurrence is not carried forward.
        //
        // A preexisting stale node carried through keep loses its incoming
        // proofs: persisted storage does not encode whether its staleness was
        // explicit or propagated, so we conservatively treat it as a direct
        // invalidation root. A propagated invalidation is different — §11a.4
        // keeps propagated freshness separate from a semantic decision, so its
        // node keeps the outgoing proofs its unchanged value supports.
        if (decision.kind === "keep" && targetFreshness.get(nodeIdentifier) === "potentially-outdated") continue;

        /** @param {import('./migration_storage').Decision | undefined} d @returns {boolean} */
        const preservesValue = (d) => d !== undefined && d.kind !== "delete" && d.kind !== "create" && d.kind !== "replace";
        const oldEdges = deriveInputEdges(oldScheme, oldLookup, nodeIdentifier);
        for (const input of finalEdges) {
            const inputDecision = decisions.get(input);
            if (!preservesValue(inputDecision)) continue;
            if (!await isFinalCached(prevStorage, decisions, input)) continue;
            if (!oldEdges.some(edge => nodeIdentifierToString(edge) === nodeIdentifierToString(input))) continue;
            const existingValidForD = await prevStorage.valid.get(input) ?? [];
            if (existingValidForD.some(id => nodeIdentifierToString(id) === nodeIdentifierToString(nodeIdentifier))) {
                addToValidSet(validSets, input, nodeIdentifier);
            }
        }
    }

    /** @type {Map<NodeIdentifier, NodeIdentifier[]>} */
    const result = new Map();
    for (const [inputString, dependents] of validSets) {
        result.set(stringToNodeIdentifier(inputString), [...dependents].sort(compareNodeIdentifier));
    }
    return result;
}


module.exports = {
    buildDecisionsMap,
    buildDesiredValid,
    buildTargetFreshness,
    loadMaterializedNodes,
};
