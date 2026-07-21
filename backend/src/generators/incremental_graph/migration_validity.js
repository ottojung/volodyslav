const {
    compareNodeIdentifier,
    nodeIdentifierToString,
    stringToNodeIdentifier,
    stringToNodeKeyString,
    deriveInputEdges,
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
 * @param {import('./database/identifier_lookup').IdentifierLookup} oldLookup
 * @param {Map<NodeIdentifier, Decision>} decisions
 * @returns {Array<[NodeIdentifier, NodeKeyString]>}
 */
function buildDecisionsMap(oldLookup, decisions) {
    /** @type {Map<string, NodeKeyString>} */
    const idToKey = new Map();
    for (const [idString, nodeKeyJson] of oldLookup.idToKey.entries()) {
        const decision = decisions.get(stringToNodeIdentifier(idString));
        if (!decision || decision.kind !== "delete") {
            idToKey.set(idString, stringToNodeKeyString(String(nodeKeyJson)));
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
 * @param {ReadableMigrationStorage} prevStorage
 * @param {Map<NodeIdentifier, Decision>} decisions
 * @param {NodeIdentifier} nodeIdentifier
 * @returns {Promise<import('./database/types').Freshness | undefined>}
 */
async function finalFreshness(prevStorage, decisions, nodeIdentifier) {
    const decision = decisions.get(nodeIdentifier);
    if (decision === undefined || decision.kind === "delete") return undefined;
    if (decision.kind === "create") return decision.freshness;
    if (decision.kind === "invalidate") return "potentially-outdated";
    return await prevStorage.freshness.get(nodeIdentifier);
}

/**
 * Build validity sets from migration decisions and scheme-derived final edges.
 * @param {ReadableMigrationStorage} prevStorage
 * @param {Map<NodeIdentifier, Decision>} decisions
 * @param {import('./database/graph_scheme').GraphScheme} oldScheme
 * @param {import('./database/graph_scheme').GraphScheme} newScheme
 * @param {import('./database/identifier_lookup').IdentifierLookup} oldLookup
 * @param {import('./database/identifier_lookup').IdentifierLookup} finalLookup
 * @returns {Promise<Map<NodeIdentifier, NodeIdentifier[]>>}
 */
async function buildDesiredValid(prevStorage, decisions, oldScheme, newScheme, oldLookup, finalLookup) {
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
                const inputFreshness = await finalFreshness(prevStorage, decisions, input);
                if (inputFreshness !== "up-to-date") {
                    throw makeInvalidMigrationDecisionError(`Cannot create ${nodeIdentifierToString(nodeIdentifier)} as up-to-date: input ${nodeIdentifierToString(input)} is ${inputFreshness ?? "not materialized"}`);
                }
                addToValidSet(validSets, input, nodeIdentifier);
            }
            continue;
        }

        // Preserve old outgoing proofs when the input's stored semantic value
        // survives — this applies to keep, override, and propagated
        // invalidations (invalidation changes freshness, not value).
        // Delete nodes have no surviving value; create nodes have no old proof.
        // Explicit invalidation is excluded above.
        //
        // A preexisting stale node carried through keep or override loses its
        // incoming proofs: persisted storage does not encode whether its
        // staleness was explicit or propagated, so we conservatively treat it
        // as a direct invalidation root.
        const nodeFreshness = await finalFreshness(prevStorage, decisions, nodeIdentifier);
        const isKeepOrOverride = decision.kind === "keep" || decision.kind === "override";
        if (isKeepOrOverride && nodeFreshness === "potentially-outdated") continue;

        /** @param {import('./migration_storage').Decision | undefined} d @returns {boolean} */
        const preservesValue = (d) => d !== undefined && d.kind !== "delete" && d.kind !== "create";
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
    loadMaterializedNodes,
};
