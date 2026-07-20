const { topologicalSortFromMap } = require('./topo_sort');
const { compareIsoTimestamps } = require('./sync_merge_timestamps');
const { makeIdentifierLookup } = require('./identifier_lookup');
const { IdentifierLookupConflictError } = require('./replica_errors');

const { GRAPH_SCHEME_KEY, parseGraphScheme, semanticInputKeys } = require('./graph_scheme');
const { normalizeInputEdges, arraysOfNodeIdentifiersEqual } = require('./input_edges');

/** @typedef {import('./identifier_lookup').IdentifierLookup} IdentifierLookup */
/** @typedef {import('./root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */

/**
 * Resolve identifier-keyed nodes into semantic input keys using a parsed graph scheme.
 * @param {ReturnType<typeof parseGraphScheme>} scheme
 * @param {IdentifierLookup} lookup
 * @param {NodeIdentifier} identifier
 * @returns {NodeKeyString[]}
 */
function semanticInputsFromScheme(scheme, lookup, identifier) {
    return semanticInputKeys(scheme, lookup, identifier);
}

/**
 * Compute the semantic merge plan, then lower its graph back to final storage identifiers.
 *
 * @param {SchemaStorage} T
 * @param {SchemaStorage} H
 * @param {IdentifierLookup} targetLookup
 * @param {IdentifierLookup} hostLookup
 * @returns {Promise<{
 *   initialDecisions: Map<NodeKeyString, 'keep' | 'take'>,
 *   mergedInputsMap: Map<NodeIdentifier, NodeIdentifier[]>,
 *   decisions: Map<NodeKeyString, 'keep' | 'take' | 'invalidate' | 'delete'>,
 *   hOnlyNeedsInvalidate: Set<NodeKeyString>,
 *   equalVersionNeedsInvalidation: Set<NodeKeyString>,
 *   finalIdentifierForKey: Map<NodeKeyString, NodeIdentifier>,
 *   finalIdentifierLookup: IdentifierLookup,
 *   hasIdentifierReconciliation: boolean
 * }>} 
 */
async function buildMergePlan(T, H, targetLookup, hostLookup) {
    const targetScheme = parseGraphScheme(await T.global.get(GRAPH_SCHEME_KEY));
    const hostScheme = parseGraphScheme(await H.global.get(GRAPH_SCHEME_KEY));

    /** @type {Map<NodeKeyString, 'keep' | 'take'>} */
    const initialDecisions = new Map();
    /** @type {Set<NodeKeyString>} */
    const forceKeepRoots = new Set();
    /** @type {Set<NodeKeyString>} */
    const forceTakeRoots = new Set();
    /** @type {Set<NodeKeyString>} */
    const allNodeKeys = new Set();

    for (const nodeKey of targetLookup.idToKey.values()) allNodeKeys.add(nodeKey);
    for (const nodeKey of hostLookup.idToKey.values()) allNodeKeys.add(nodeKey);

    /** @type {Set<NodeKeyString>} */
    const targetOnlyNodes = new Set();
    /** @type {Set<NodeKeyString>} */
    const hOnlyNodes = new Set();
    /** @type {Set<NodeKeyString>} */
    const equalTimestamps = new Set();
    for (const nodeKey of allNodeKeys) {
        const targetId = targetLookup.keyToId.get(String(nodeKey));
        const hostId = hostLookup.keyToId.get(String(nodeKey));
        if (targetId === undefined) {
            initialDecisions.set(nodeKey, 'take');
            hOnlyNodes.add(nodeKey);
            continue;
        }
        if (hostId === undefined) {
            initialDecisions.set(nodeKey, 'keep');
            targetOnlyNodes.add(nodeKey);
            continue;
        }

        const targetTimestamps = await T.timestamps.get(targetId);
        const hostTimestamps = await H.timestamps.get(hostId);
        const cmp = compareIsoTimestamps(
            targetTimestamps?.modifiedAt,
            hostTimestamps?.modifiedAt
        );
        if (cmp >= 0) {
            initialDecisions.set(nodeKey, 'keep');
            if (cmp > 0) forceKeepRoots.add(nodeKey);
        } else {
            initialDecisions.set(nodeKey, 'take');
            forceTakeRoots.add(nodeKey);
        }

        if (cmp === 0) {
            equalTimestamps.add(nodeKey);
        }
    }

    /** @type {Map<NodeKeyString, NodeKeyString[]>} */
    const initiallyChosenInputsMap = new Map();
    for (const [nodeKey, initial] of initialDecisions) {
        const lookup = initial === 'take' ? hostLookup : targetLookup;
        const scheme = initial === 'take' ? hostScheme : targetScheme;
        const identifier = lookup.keyToId.get(String(nodeKey));
        if (identifier === undefined) {
            throw new IdentifierLookupConflictError(`Missing ${initial} identifier for semantic node ${String(nodeKey)}`);
        }
        initiallyChosenInputsMap.set(nodeKey, semanticInputsFromScheme(scheme, lookup, identifier));
    }

    const topoList = topologicalSortFromMap(initiallyChosenInputsMap);
    /** @type {Set<NodeKeyString>} */
    const keepTainted = new Set(forceKeepRoots);
    /** @type {Set<NodeKeyString>} */
    const takeTainted = new Set(forceTakeRoots);
    for (const nodeKey of topoList) {
        for (const inputKey of initiallyChosenInputsMap.get(nodeKey) ?? []) {
            if (keepTainted.has(inputKey)) keepTainted.add(nodeKey);
            if (takeTainted.has(inputKey)) takeTainted.add(nodeKey);
        }
    }

    /** @type {Map<NodeKeyString, 'keep' | 'take' | 'invalidate' | 'delete'>} */
    const decisions = new Map();
    /** @type {Set<NodeKeyString>} */
    const hOnlyNeedsInvalidate = new Set();
    for (const [nodeKey, initial] of initialDecisions) {
        const inKeep = keepTainted.has(nodeKey);
        const inTake = takeTainted.has(nodeKey);
        if (targetOnlyNodes.has(nodeKey)) {
            decisions.set(nodeKey, inTake ? 'invalidate' : 'keep');
        } else if (hOnlyNodes.has(nodeKey)) {
            decisions.set(nodeKey, 'take');
            if (inKeep) hOnlyNeedsInvalidate.add(nodeKey);
        } else if (inKeep && inTake) {
            decisions.set(nodeKey, 'invalidate');
        } else if (inKeep) {
            decisions.set(nodeKey, 'keep');
        } else if (inTake) {
            decisions.set(nodeKey, 'take');
        } else {
            decisions.set(nodeKey, initial);
        }
    }

    /** @type {Map<NodeKeyString, NodeIdentifier>} */
    const candidateIdentifierForKey = new Map();
    for (const [nodeKey, initial] of initialDecisions) {
        const targetId = targetLookup.keyToId.get(String(nodeKey));
        const hostId = hostLookup.keyToId.get(String(nodeKey));
        const decision = decisions.get(nodeKey);
        const finalSide = decision === 'invalidate' ? initial : decision;
        const candidateId = finalSide === 'take' ? hostId : targetId;
        if (finalSide === undefined || candidateId === undefined) {
            throw new IdentifierLookupConflictError(`Missing candidate identifier for ${String(nodeKey)}`);
        }
        candidateIdentifierForKey.set(nodeKey, candidateId);
    }

    // Equal-version staleness: determined after final decisions are known,
    // because taint propagation can change which side ultimately wins.
    /** @type {Set<NodeKeyString>} */
    const equalVersionNeedsInvalidation = new Set();
    for (const nodeKey of equalTimestamps) {
        const targetId = targetLookup.keyToId.get(String(nodeKey));
        const hostId = hostLookup.keyToId.get(String(nodeKey));
        if (targetId === undefined || hostId === undefined) continue;
        const initial = initialDecisions.get(nodeKey);
        if (initial === undefined) continue;
        const decision = decisions.get(nodeKey);
        if (decision === undefined) continue;
        const finalSide = decision === 'invalidate' ? initial : decision;
        const finalIsTake = finalSide === 'take';
        const finalId = finalIsTake ? hostId : targetId;
        const otherId = finalIsTake ? targetId : hostId;
        const finalStorage = finalIsTake ? H : T;
        const otherStorage = finalIsTake ? T : H;
        const finalFreshness = await finalStorage.freshness.get(finalId);
        const otherFreshness = await otherStorage.freshness.get(otherId);
        if (finalFreshness === 'up-to-date' && otherFreshness !== 'up-to-date') {
            equalVersionNeedsInvalidation.add(nodeKey);
        }
    }

    /** @type {Map<NodeKeyString, NodeKeyString[]>} */
    const candidateInputsByKey = new Map();
    /** @type {Map<NodeKeyString, Set<NodeKeyString>>} */
    const candidateDependentsByKey = new Map();
    /** @type {Set<NodeKeyString>} */
    const directlyReloweredNodes = new Set();
    for (const [nodeKey, decision] of decisions) {
        const initial = initialDecisions.get(nodeKey);
        const structuralSide = decision === 'invalidate' ? initial : decision;
        const lookup = structuralSide === 'take' ? hostLookup : targetLookup;
        const scheme = structuralSide === 'take' ? hostScheme : targetScheme;
        const sourceId = lookup.keyToId.get(String(nodeKey));
        if (sourceId === undefined) {
            throw new IdentifierLookupConflictError(`Missing lowered identifier for ${String(nodeKey)}`);
        }
        const inputKeys = semanticInputsFromScheme(scheme, lookup, sourceId);
        candidateInputsByKey.set(nodeKey, inputKeys);
        for (const inputKey of inputKeys) {
            const dependents = candidateDependentsByKey.get(inputKey) ?? new Set();
            dependents.add(nodeKey);
            candidateDependentsByKey.set(inputKey, dependents);
        }

        const sourceInputIds = inputKeys.map((inputKey) => {
            const inputId = lookup.keyToId.get(String(inputKey));
            if (inputId === undefined) {
                throw new IdentifierLookupConflictError(`Missing source input identifier for ${String(inputKey)}`);
            }
            return inputId;
        });

        const candidateInputIds = inputKeys.map((inputKey) => {
            const inputId = candidateIdentifierForKey.get(inputKey);
            if (inputId === undefined) {
                throw new IdentifierLookupConflictError(`Missing candidate input identifier for ${String(inputKey)}`);
            }
            return inputId;
        });

        if (!arraysOfNodeIdentifiersEqual(normalizeInputEdges(sourceInputIds), normalizeInputEdges(candidateInputIds))) {
            directlyReloweredNodes.add(nodeKey);
        }
    }

    /** @type {Set<NodeKeyString>} */
    const deletedMaterializationKeys = new Set(directlyReloweredNodes);
    const queue = [...directlyReloweredNodes];
    let head = 0;
    while (head < queue.length) {
        const deletedKey = queue[head];
        head += 1;
        if (deletedKey === undefined) break;
        for (const dependentKey of candidateDependentsByKey.get(deletedKey) ?? []) {
            if (deletedMaterializationKeys.has(dependentKey)) continue;
            deletedMaterializationKeys.add(dependentKey);
            queue.push(dependentKey);
        }
    }
    for (const nodeKey of deletedMaterializationKeys) {
        decisions.set(nodeKey, 'delete');
    }

    /** @type {Map<NodeKeyString, NodeIdentifier>} */
    const finalIdentifierForKey = new Map();
    /** @type {Array<[NodeIdentifier, NodeKeyString]>} */
    const finalEntries = [];
    for (const [nodeKey, identifier] of candidateIdentifierForKey) {
        if (deletedMaterializationKeys.has(nodeKey)) continue;
        finalIdentifierForKey.set(nodeKey, identifier);
        finalEntries.push([identifier, nodeKey]);
    }
    const finalIdentifierLookup = makeIdentifierLookup(finalEntries);
    let hasIdentifierReconciliation = false;
    for (const [nodeKey, finalId] of finalIdentifierForKey) {
        const targetId = targetLookup.keyToId.get(String(nodeKey));
        if (targetId !== undefined && targetId !== finalId) {
            hasIdentifierReconciliation = true;
        }
    }

    /** @type {Map<NodeIdentifier, NodeIdentifier[]>} */
    const mergedInputsMap = new Map();
    for (const [nodeKey, inputKeys] of candidateInputsByKey) {
        if (deletedMaterializationKeys.has(nodeKey)) continue;
        const finalId = finalIdentifierForKey.get(nodeKey);
        if (finalId === undefined) {
            throw new IdentifierLookupConflictError(`Missing final identifier for ${String(nodeKey)}`);
        }
        const finalInputEdges = normalizeInputEdges(inputKeys.map((inputKey) => {
            const inputId = finalIdentifierForKey.get(inputKey);
            if (inputId === undefined) {
                throw new IdentifierLookupConflictError(`Missing final input identifier for ${String(inputKey)}`);
            }
            return inputId;
        }));
        mergedInputsMap.set(finalId, finalInputEdges);
    }

    return {
        initialDecisions,
        mergedInputsMap,
        decisions,
        hOnlyNeedsInvalidate,
        equalVersionNeedsInvalidation,
        finalIdentifierForKey,
        finalIdentifierLookup,
        hasIdentifierReconciliation,
    };
}

module.exports = { buildMergePlan };
