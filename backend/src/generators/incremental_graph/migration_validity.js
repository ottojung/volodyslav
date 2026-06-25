const {
    compareNodeIdentifier,
    IDENTIFIERS_KEY,
    nodeIdentifierToString,
    stringToNodeIdentifier,
    stringToNodeKeyString,
    makeEmptyIdentifierLookup,
    parseIdentifierLookup,
    deriveInputEdges,
} = require("./database");

/** @typedef {import('./database/root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./database/types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./database/types').NodeKeyString} NodeKeyString */
/** @typedef {import('./database').ReadableSchemaStorage} ReadableSchemaStorage */
/** @typedef {import('./migration_storage').ReadableMigrationStorage} ReadableMigrationStorage */
/** @typedef {import('./migration_storage').Decision} Decision */

/**
 * Collect all materialized node keys from a schema storage.
 * @param {SchemaStorage} storage
 * @returns {Promise<NodeIdentifier[]>}
 */
async function loadMaterializedNodes(storage) {
    const rawIdentifiers = await storage.global.get(IDENTIFIERS_KEY);
    const lookup = rawIdentifiers === undefined
        ? makeEmptyIdentifierLookup()
        : parseIdentifierLookup(rawIdentifiers, 'migration source replica');
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
 * @param {ReadableMigrationStorage} prevStorage
 * @param {Map<NodeIdentifier, Decision>} decisions
 * @returns {Promise<Array<[NodeIdentifier, NodeKeyString]>>}
 */
async function buildDecisionsMap(prevStorage, decisions) {
    const oldEntries = await prevStorage.global.get(IDENTIFIERS_KEY);

    /** @type {Map<string, NodeKeyString>} */
    const idToKey = new Map();
    if (Array.isArray(oldEntries)) {
        for (const [id, nodeKeyJson] of oldEntries) {
            const decision = decisions.get(stringToNodeIdentifier(String(id)));
            if (!decision || decision.kind !== "delete") {
                idToKey.set(String(id), stringToNodeKeyString(String(nodeKeyJson)));
            }
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
    const cached = new Set();
    for (const [nodeIdentifier, decision] of decisions) {
        if (decision.kind === 'delete') continue;
        if (decision.kind === 'create' || decision.kind === 'override') {
            cached.add(nodeIdentifierToString(nodeIdentifier));
        } else if (await prevStorage.values.get(nodeIdentifier) !== undefined) {
            cached.add(nodeIdentifierToString(nodeIdentifier));
        }
    }

    for (const [nodeIdentifier, decision] of decisions) {
        if (decision.kind === "delete" || decision.kind === "invalidate") continue;
        const finalEdges = deriveInputEdges(newScheme, finalLookup, nodeIdentifier);
        for (const edge of finalEdges) {
            if (!materialized.has(nodeIdentifierToString(edge))) {
                throw new Error(`Migration dependency ${nodeIdentifierToString(edge)} for ${nodeIdentifierToString(nodeIdentifier)} is not materialized in the target replica`);
            }
        }

        if (!cached.has(nodeIdentifierToString(nodeIdentifier))) continue;

        const finalFreshness = decision.kind === "keep"
            ? await prevStorage.freshness.get(nodeIdentifier)
            : "up-to-date";
        if (finalFreshness === "up-to-date") {
            for (const input of finalEdges) {
                if (cached.has(nodeIdentifierToString(input))) {
                    addToValidSet(validSets, input, nodeIdentifier);
                }
            }
            continue;
        }

        if (decision.kind !== "keep" || finalFreshness !== "potentially-outdated") continue;
        const oldEdges = deriveInputEdges(oldScheme, oldLookup, nodeIdentifier);
        for (const input of finalEdges) {
            const inputDecision = decisions.get(input);
            if (!inputDecision || inputDecision.kind !== "keep") continue;
            if (!cached.has(nodeIdentifierToString(input))) continue;
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
