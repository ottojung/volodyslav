const { topologicalSortFromMap } = require('./topo_sort');
const { compareIsoTimestamps } = require('./sync_merge_timestamps');
const { makeIdentifierLookup } = require('./identifier_lookup');
const { IdentifierLookupConflictError } = require('./replica_errors');

const { GRAPH_SCHEME_KEY, parseGraphScheme, semanticInputKeys } = require('./graph_scheme');
const { normalizeInputEdges, arraysOfNodeIdentifiersEqual } = require('./input_edges');
const { buildTransportedValidityPlan } = require('./sync_merge_validity');

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
 * Count distinct semantic direct inputs.
 * @param {NodeKeyString[]} inputKeys
 * @returns {number}
 */
function countDistinctSemanticInputs(inputKeys) {
    return new Set(inputKeys.map(String)).size;
}

/**
 * Classify direct invalidation candidates under the temporary pairwise policy.
 * @param {Set<NodeKeyString>} directInvalidationCandidateKeys
 * @param {Map<NodeKeyString, NodeKeyString[]>} selectedInputsByKey
 * @returns {{ hardInvalidationKeys: Set<NodeKeyString>, deletionRootKeys: Set<NodeKeyString> }}
 */
function classifyInvalidationCandidates(directInvalidationCandidateKeys, selectedInputsByKey) {
    /** @type {Set<NodeKeyString>} */
    const hardInvalidationKeys = new Set();
    /** @type {Set<NodeKeyString>} */
    const deletionRootKeys = new Set();
    for (const nodeKey of directInvalidationCandidateKeys) {
        // FIXME(#1521): This arity-based invalidate-vs-delete rule is deliberately
        // conservative. The current pairwise database state does not retain exact
        // historical input-version provenance, so it cannot determine whether a
        // multi-input oldValue belongs to one coherent history. Until the graph
        // journal provides that provenance, direct hard-invalidation roots with at
        // most one distinct semantic input retain oldValue, while multi-input roots
        // are deleted. Replace this classifier with journal-backed coherent-history
        // analysis when #1521 is implemented.
        if (countDistinctSemanticInputs(selectedInputsByKey.get(nodeKey) ?? []) > 1) {
            deletionRootKeys.add(nodeKey);
        } else {
            hardInvalidationKeys.add(nodeKey);
        }
    }
    return { hardInvalidationKeys, deletionRootKeys };
}

/**
 * @param {Set<NodeKeyString>} deletionRootKeys
 * @param {Map<NodeKeyString, Set<NodeKeyString>>} dependentsByKey
 * @returns {Set<NodeKeyString>}
 */
function expandStructuralDeletionClosure(deletionRootKeys, dependentsByKey) {
    /** @type {Set<NodeKeyString>} */
    const deletedMaterializationKeys = new Set(deletionRootKeys);
    const queue = [...deletionRootKeys];
    let head = 0;
    while (head < queue.length) {
        const deletedKey = queue[head];
        head += 1;
        if (deletedKey === undefined) break;
        for (const dependentKey of dependentsByKey.get(deletedKey) ?? []) {
            if (deletedMaterializationKeys.has(dependentKey)) continue;
            deletedMaterializationKeys.add(dependentKey);
            queue.push(dependentKey);
        }
    }
    return deletedMaterializationKeys;
}

/**
 * Find up-to-date selected nodes whose required direct-input proofs cannot be transported.
 * @param {SchemaStorage} T
 * @param {SchemaStorage} H
 * @param {IdentifierLookup} targetLookup
 * @param {IdentifierLookup} hostLookup
 * @param {Map<NodeKeyString, 'keep' | 'take'>} selectedSideByKey
 * @param {Map<NodeKeyString, NodeKeyString[]>} selectedInputsByKey
 * @param {Map<NodeKeyString, NodeIdentifier>} finalIdentifierForKey
 * @returns {Promise<Set<NodeKeyString>>}
 */
async function findMissingTransportedProofRoots(T, H, targetLookup, hostLookup, selectedSideByKey, selectedInputsByKey, finalIdentifierForKey) {
    /** @type {Map<NodeKeyString, import('./sync_merge_validity').ValueOrigin>} */
    const originByKey = new Map();
    /** @type {Map<NodeIdentifier, NodeIdentifier[]>} */
    const mergedInputsMap = new Map();
    for (const [nodeKey, side] of selectedSideByKey) {
        const finalId = finalIdentifierForKey.get(nodeKey);
        if (finalId === undefined) continue;
        const lookup = side === 'take' ? hostLookup : targetLookup;
        const sourceId = lookup.keyToId.get(String(nodeKey));
        if (sourceId !== undefined) {
            originByKey.set(nodeKey, { kind: 'source', side: side === 'take' ? 'host' : 'target', sourceId });
        }
        const inputIds = [];
        for (const inputKey of selectedInputsByKey.get(nodeKey) ?? []) {
            const inputId = finalIdentifierForKey.get(inputKey);
            if (inputId !== undefined) inputIds.push(inputId);
        }
        mergedInputsMap.set(finalId, normalizeInputEdges(inputIds));
    }
    const { validMap: transportedProofs } = await buildTransportedValidityPlan({
        targetSourceStorage: T,
        hostSourceStorage: H,
        targetLookup,
        hostLookup,
        finalIdentifierForKey,
        mergedInputsMap,
        valueOriginByKey: originByKey,
    });

    /** @type {Set<NodeKeyString>} */
    const missingRoots = new Set();
    for (const [nodeKey, inputKeys] of selectedInputsByKey) {
        const finalNodeId = finalIdentifierForKey.get(nodeKey);
        if (finalNodeId === undefined || inputKeys.length === 0) continue;
        const side = selectedSideByKey.get(nodeKey);
        const lookup = side === 'take' ? hostLookup : targetLookup;
        const storage = side === 'take' ? H : T;
        const sourceId = lookup.keyToId.get(String(nodeKey));
        if (sourceId === undefined) continue;
        if (await storage.freshness.get(sourceId) !== 'up-to-date') continue;
        for (const inputKey of inputKeys) {
            const finalInputId = finalIdentifierForKey.get(inputKey);
            if (finalInputId === undefined) continue;
            const dependents = transportedProofs.get(String(finalInputId)) ?? [];
            if (!dependents.some(dependent => String(dependent) === String(finalNodeId))) {
                missingRoots.add(nodeKey);
                break;
            }
        }
    }
    return missingRoots;
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
 *   selectedSideByKey: Map<NodeKeyString, 'keep' | 'take'>,
 *   selectedInputsByKey: Map<NodeKeyString, NodeKeyString[]>,
 *   directInvalidationCandidateKeys: Set<NodeKeyString>,
 *   hardInvalidationKeys: Set<NodeKeyString>,
 *   deletionRootKeys: Set<NodeKeyString>,
 *   deletedMaterializationKeys: Set<NodeKeyString>,
 *   mergedInputsMap: Map<NodeIdentifier, NodeIdentifier[]>,
 *   decisions: Map<NodeKeyString, 'keep' | 'take' | 'invalidate' | 'delete'>,
 *   finalIdentifierForKey: Map<NodeKeyString, NodeIdentifier>,
 *   finalIdentifierLookup: IdentifierLookup,
 *   hasIdentifierReconciliation: boolean
 * }>} 
 */
async function buildMergePlan(T, H, targetLookup, hostLookup) {
    const targetScheme = parseGraphScheme(await T.global.get(GRAPH_SCHEME_KEY));
    const hostScheme = parseGraphScheme(await H.global.get(GRAPH_SCHEME_KEY));

    /** @type {Map<NodeKeyString, 'keep' | 'take'>} */
    const selectedSideByKey = new Map();
    /** @type {Set<NodeKeyString>} */
    const forceKeepRoots = new Set();
    /** @type {Set<NodeKeyString>} */
    const forceTakeRoots = new Set();
    /** @type {Set<NodeKeyString>} */
    const allNodeKeys = new Set();
    for (const nodeKey of targetLookup.idToKey.values()) allNodeKeys.add(nodeKey);
    for (const nodeKey of hostLookup.idToKey.values()) allNodeKeys.add(nodeKey);

    /** @type {Set<NodeKeyString>} */
    const equalTimestamps = new Set();
    for (const nodeKey of allNodeKeys) {
        const targetId = targetLookup.keyToId.get(String(nodeKey));
        const hostId = hostLookup.keyToId.get(String(nodeKey));
        if (targetId === undefined) {
            selectedSideByKey.set(nodeKey, 'take');
            continue;
        }
        if (hostId === undefined) {
            selectedSideByKey.set(nodeKey, 'keep');
            continue;
        }
        const targetTimestamps = await T.timestamps.get(targetId);
        const hostTimestamps = await H.timestamps.get(hostId);
        const cmp = compareIsoTimestamps(targetTimestamps?.modifiedAt, hostTimestamps?.modifiedAt);
        if (cmp >= 0) {
            selectedSideByKey.set(nodeKey, 'keep');
            if (cmp > 0) forceKeepRoots.add(nodeKey);
        } else {
            selectedSideByKey.set(nodeKey, 'take');
            forceTakeRoots.add(nodeKey);
        }
        if (cmp === 0) equalTimestamps.add(nodeKey);
    }

    /** @type {Map<NodeKeyString, NodeKeyString[]>} */
    const selectedInputsByKey = new Map();
    for (const [nodeKey, selectedSide] of selectedSideByKey) {
        const lookup = selectedSide === 'take' ? hostLookup : targetLookup;
        const scheme = selectedSide === 'take' ? hostScheme : targetScheme;
        const identifier = lookup.keyToId.get(String(nodeKey));
        if (identifier === undefined) throw new IdentifierLookupConflictError(`Missing ${selectedSide} identifier for semantic node ${String(nodeKey)}`);
        selectedInputsByKey.set(nodeKey, semanticInputsFromScheme(scheme, lookup, identifier));
    }

    const topoList = topologicalSortFromMap(selectedInputsByKey);
    /** @type {Set<NodeKeyString>} */
    const keepTainted = new Set(forceKeepRoots);
    /** @type {Set<NodeKeyString>} */
    const takeTainted = new Set(forceTakeRoots);
    for (const nodeKey of topoList) {
        for (const inputKey of selectedInputsByKey.get(nodeKey) ?? []) {
            if (keepTainted.has(inputKey)) keepTainted.add(nodeKey);
            if (takeTainted.has(inputKey)) takeTainted.add(nodeKey);
        }
    }

    /** @type {Set<NodeKeyString>} */
    const directInvalidationCandidateKeys = new Set();
    for (const [nodeKey, selectedSide] of selectedSideByKey) {
        if ((selectedSide === 'keep' && takeTainted.has(nodeKey))
            || (selectedSide === 'take' && keepTainted.has(nodeKey))) {
            directInvalidationCandidateKeys.add(nodeKey);
        }
    }

    /** @type {Map<NodeKeyString, NodeIdentifier>} */
    const provisionalIdentifierForKey = new Map();
    for (const [nodeKey, selectedSide] of selectedSideByKey) {
        const lookup = selectedSide === 'take' ? hostLookup : targetLookup;
        const id = lookup.keyToId.get(String(nodeKey));
        if (id === undefined) throw new IdentifierLookupConflictError(`Missing candidate identifier for ${String(nodeKey)}`);
        provisionalIdentifierForKey.set(nodeKey, id);
    }

    /** @type {Map<NodeKeyString, Set<NodeKeyString>>} */
    const selectedDependentsByKey = new Map();
    /** @type {Set<NodeKeyString>} */
    const directlyReloweredNodes = new Set();
    for (const [nodeKey, inputKeys] of selectedInputsByKey) {
        for (const inputKey of inputKeys) {
            const dependents = selectedDependentsByKey.get(inputKey) ?? new Set();
            dependents.add(nodeKey);
            selectedDependentsByKey.set(inputKey, dependents);
        }
        const selectedSide = selectedSideByKey.get(nodeKey);
        const lookup = selectedSide === 'take' ? hostLookup : targetLookup;
        const sourceInputIds = inputKeys.map((inputKey) => {
            const inputId = lookup.keyToId.get(String(inputKey));
            if (inputId === undefined) throw new IdentifierLookupConflictError(`Missing source input identifier for ${String(inputKey)}`);
            return inputId;
        });
        const finalInputIds = inputKeys.map((inputKey) => {
            const inputId = provisionalIdentifierForKey.get(inputKey);
            if (inputId === undefined) throw new IdentifierLookupConflictError(`Missing candidate input identifier for ${String(inputKey)}`);
            return inputId;
        });
        if (!arraysOfNodeIdentifiersEqual(normalizeInputEdges(sourceInputIds), normalizeInputEdges(finalInputIds))) {
            directlyReloweredNodes.add(nodeKey);
            directInvalidationCandidateKeys.add(nodeKey);
        }
    }

    for (const nodeKey of equalTimestamps) {
        const targetId = targetLookup.keyToId.get(String(nodeKey));
        const hostId = hostLookup.keyToId.get(String(nodeKey));
        if (targetId === undefined || hostId === undefined) continue;
        const finalFreshness = await T.freshness.get(targetId);
        const otherFreshness = await H.freshness.get(hostId);
        if (finalFreshness === 'up-to-date' && otherFreshness !== 'up-to-date') {
            directInvalidationCandidateKeys.add(nodeKey);
        }
    }

    let finalIdentifierForKey = new Map(provisionalIdentifierForKey);
    /** @type {Set<NodeKeyString>} */
    let deletedMaterializationKeys = new Set();
    /** @type {Set<NodeKeyString>} */
    let hardInvalidationKeys = new Set();
    /** @type {Set<NodeKeyString>} */
    let deletionRootKeys = new Set();
    let changed = true;
    while (changed) {
        const missingProofRoots = await findMissingTransportedProofRoots(
            T, H, targetLookup, hostLookup, selectedSideByKey, selectedInputsByKey, finalIdentifierForKey
        );
        for (const nodeKey of missingProofRoots) directInvalidationCandidateKeys.add(nodeKey);
        const classified = classifyInvalidationCandidates(directInvalidationCandidateKeys, selectedInputsByKey);
        deletionRootKeys = classified.deletionRootKeys;
        deletedMaterializationKeys = expandStructuralDeletionClosure(deletionRootKeys, selectedDependentsByKey);
        hardInvalidationKeys = new Set([...classified.hardInvalidationKeys].filter(key => !deletedMaterializationKeys.has(key)));
        const nextFinalIdentifierForKey = new Map();
        for (const [nodeKey, identifier] of provisionalIdentifierForKey) {
            if (!deletedMaterializationKeys.has(nodeKey)) nextFinalIdentifierForKey.set(nodeKey, identifier);
        }
        changed = nextFinalIdentifierForKey.size !== finalIdentifierForKey.size;
        finalIdentifierForKey = nextFinalIdentifierForKey;
    }

    /** @type {Map<NodeKeyString, 'keep' | 'take' | 'invalidate' | 'delete'>} */
    const decisions = new Map();
    for (const [nodeKey, selectedSide] of selectedSideByKey) {
        if (deletedMaterializationKeys.has(nodeKey)) decisions.set(nodeKey, 'delete');
        else if (hardInvalidationKeys.has(nodeKey)) decisions.set(nodeKey, 'invalidate');
        else decisions.set(nodeKey, selectedSide);
    }

    /** @type {Array<[NodeIdentifier, NodeKeyString]>} */
    const finalEntries = [];
    for (const [nodeKey, identifier] of finalIdentifierForKey) finalEntries.push([identifier, nodeKey]);
    const finalIdentifierLookup = makeIdentifierLookup(finalEntries);
    let hasIdentifierReconciliation = false;
    for (const [nodeKey, finalId] of finalIdentifierForKey) {
        const targetId = targetLookup.keyToId.get(String(nodeKey));
        if (targetId !== undefined && targetId !== finalId) hasIdentifierReconciliation = true;
    }

    /** @type {Map<NodeIdentifier, NodeIdentifier[]>} */
    const mergedInputsMap = new Map();
    for (const [nodeKey, inputKeys] of selectedInputsByKey) {
        if (deletedMaterializationKeys.has(nodeKey)) continue;
        const finalId = finalIdentifierForKey.get(nodeKey);
        if (finalId === undefined) throw new IdentifierLookupConflictError(`Missing final identifier for ${String(nodeKey)}`);
        const finalInputEdges = normalizeInputEdges(inputKeys.map((inputKey) => {
            const inputId = finalIdentifierForKey.get(inputKey);
            if (inputId === undefined) throw new IdentifierLookupConflictError(`Missing final input identifier for ${String(inputKey)}`);
            return inputId;
        }));
        mergedInputsMap.set(finalId, finalInputEdges);
    }

    return {
        initialDecisions: selectedSideByKey,
        selectedSideByKey,
        selectedInputsByKey,
        directInvalidationCandidateKeys,
        hardInvalidationKeys,
        deletionRootKeys,
        deletedMaterializationKeys,
        mergedInputsMap,
        decisions,
        finalIdentifierForKey,
        finalIdentifierLookup,
        hasIdentifierReconciliation,
    };
}

module.exports = { buildMergePlan };
