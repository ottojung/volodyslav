const { topologicalSortFromMap } = require('./topo_sort');
const { makeIdentifierLookup } = require('./identifier_lookup');
const { IdentifierLookupConflictError } = require('./replica_errors');

const { GRAPH_SCHEME_KEY, parseGraphScheme, semanticInputKeys } = require('./graph_scheme');
const { normalizeInputEdges, arraysOfNodeIdentifiersEqual } = require('./input_edges');
const { valueClocksEqual, joinValueClocks } = require('./value_clock');
const { readSourceState, mergeSourceStates } = require('./sync_merge_source_state');

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
 * @param {SchemaStorage} T
 * @param {SchemaStorage} H
 * @param {IdentifierLookup} targetLookup
 * @param {IdentifierLookup} hostLookup
 * @param {NodeKeyString} nodeKey
 * @returns {Promise<import('./value_clock').ValueClock>}
 */
async function joinedSourceFrontier(T, H, targetLookup, hostLookup, nodeKey) {
    /** @type {import('./value_clock').ValueClock | undefined} */
    let frontier;
    for (const source of [
        { storage: T, lookup: targetLookup },
        { storage: H, lookup: hostLookup },
    ]) {
        const existingFrontier = await source.storage.conflictFrontiers.get(nodeKey);
        if (existingFrontier !== undefined) {
            frontier = frontier === undefined ? existingFrontier : joinValueClocks(frontier, existingFrontier);
        }
        const identifier = source.lookup.keyToId.get(String(nodeKey));
        if (identifier !== undefined) {
            const clock = await source.storage.valueClocks.get(identifier);
            if (clock === undefined) throw new IdentifierLookupConflictError(`Materialized node ${String(identifier)} has no value clock`);
            frontier = frontier === undefined ? clock : joinValueClocks(frontier, clock);
        }
    }
    if (frontier === undefined) throw new IdentifierLookupConflictError(`Deleted key ${String(nodeKey)} has no causal frontier`);
    return frontier;
}

/**
 * Compute the semantic merge plan, then lower its graph back to final storage identifiers.
 *
 * @param {SchemaStorage} T
 * @param {SchemaStorage} H
 * @param {IdentifierLookup} targetLookup
 * @param {IdentifierLookup} hostLookup
 * @returns {Promise<{
 *   selectedSourceByKey: Map<NodeKeyString, 'keep' | 'take'>,
 *   mergedInputsMap: Map<NodeIdentifier, NodeIdentifier[]>,
 *   conflictInvalidationCandidates: Set<NodeKeyString>,
 *   directInvalidationKeys: Set<NodeKeyString>,
 *   conflictedKeys: Set<NodeKeyString>,
 *   deletedMaterializationKeys: Set<NodeKeyString>,
 *   finalConflictFrontierByKey: Map<NodeKeyString, import('./value_clock').ValueClock>,
 *   finalIdentifierForKey: Map<NodeKeyString, NodeIdentifier>,
 *   finalIdentifierLookup: IdentifierLookup,
 *   hasIdentifierReconciliation: boolean
 * }>} 
 */
async function buildMergePlan(T, H, targetLookup, hostLookup) {
    const targetScheme = parseGraphScheme(await T.global.get(GRAPH_SCHEME_KEY));
    const hostScheme = parseGraphScheme(await H.global.get(GRAPH_SCHEME_KEY));

    /** @type {Set<NodeKeyString>} */
    const allNodeKeys = new Set();
    for (const nodeKey of targetLookup.idToKey.values()) allNodeKeys.add(nodeKey);
    for (const nodeKey of hostLookup.idToKey.values()) allNodeKeys.add(nodeKey);
    for await (const nodeKey of T.conflictFrontiers.keys()) allNodeKeys.add(nodeKey);
    for await (const nodeKey of H.conflictFrontiers.keys()) allNodeKeys.add(nodeKey);

    /** @type {Map<NodeKeyString, 'keep' | 'take'>} */
    const selectedSourceByKey = new Map();
    /** @type {Map<NodeKeyString, NodeIdentifier>} */
    const candidateIdentifierForKey = new Map();
    /** @type {Set<NodeKeyString>} */
    const conflictedKeys = new Set();
    /** @type {Map<NodeKeyString, import('./value_clock').ValueClock>} */
    const rootConflictFrontierByKey = new Map();
    /** @type {Set<NodeKeyString>} */
    const forceKeepRoots = new Set();
    /** @type {Set<NodeKeyString>} */
    const forceTakeRoots = new Set();
    /** @type {Set<NodeKeyString>} */
    const conservativeFreshnessInvalidationKeys = new Set();

    for (const nodeKey of allNodeKeys) {
        const targetState = await readSourceState(T, targetLookup, 'keep', nodeKey);
        const hostState = await readSourceState(H, hostLookup, 'take', nodeKey);
        const mergedState = mergeSourceStates(targetState, hostState);
        if (mergedState.kind === 'conflicted') {
            conflictedKeys.add(nodeKey);
            rootConflictFrontierByKey.set(nodeKey, mergedState.frontier);
            continue;
        }
        if (mergedState.kind === 'absent') continue;
        selectedSourceByKey.set(nodeKey, mergedState.side);
        candidateIdentifierForKey.set(nodeKey, mergedState.identifier);
        if (targetState.kind === 'materialized' && hostState.kind === 'materialized') {
            if (mergedState.side === 'keep' && !valueClocksEqual(targetState.clock, hostState.clock)) forceKeepRoots.add(nodeKey);
            if (mergedState.side === 'take' && !valueClocksEqual(targetState.clock, hostState.clock)) forceTakeRoots.add(nodeKey);
            const finalFreshness = await (mergedState.side === 'take' ? H : T).freshness.get(mergedState.identifier);
            const otherFreshness = await (mergedState.side === 'take' ? T : H).freshness.get(mergedState.side === 'take' ? targetState.identifier : hostState.identifier);
            if (finalFreshness === 'up-to-date' && otherFreshness !== 'up-to-date') {
                conservativeFreshnessInvalidationKeys.add(nodeKey);
            }
        }
    }

    /** @type {Map<NodeKeyString, NodeKeyString[]>} */
    const initiallyChosenInputsMap = new Map();
    for (const [nodeKey, selected] of selectedSourceByKey) {
        const lookup = selected === 'take' ? hostLookup : targetLookup;
        const scheme = selected === 'take' ? hostScheme : targetScheme;
        const identifier = lookup.keyToId.get(String(nodeKey));
        if (identifier === undefined) {
            throw new IdentifierLookupConflictError(`Missing ${selected} identifier for semantic node ${String(nodeKey)}`);
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

    /** @type {Set<NodeKeyString>} */
    const conflictInvalidationCandidates = new Set(conservativeFreshnessInvalidationKeys);
    for (const nodeKey of selectedSourceByKey.keys()) {
        const selected = selectedSourceByKey.get(nodeKey);
        const targetHas = targetLookup.keyToId.has(String(nodeKey));
        const hostHas = hostLookup.keyToId.has(String(nodeKey));
        const inKeep = keepTainted.has(nodeKey);
        const inTake = takeTainted.has(nodeKey);
        if (targetHas && !hostHas && inTake) conflictInvalidationCandidates.add(nodeKey);
        else if (!targetHas && hostHas && inKeep) conflictInvalidationCandidates.add(nodeKey);
        else if (inKeep && inTake) conflictInvalidationCandidates.add(nodeKey);
        if (selected === undefined) throw new IdentifierLookupConflictError(`Missing selected source for ${String(nodeKey)}`);
    }

    /** @type {Map<NodeKeyString, NodeKeyString[]>} */
    const candidateInputsByKey = new Map();
    /** @type {Map<NodeKeyString, Set<NodeKeyString>>} */
    const candidateDependentsByKey = new Map();
    for (const [nodeKey, structuralSide] of selectedSourceByKey) {
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
            if (inputId === undefined) throw new IdentifierLookupConflictError(`Missing source input identifier for ${String(inputKey)}`);
            return inputId;
        });
        const candidateInputIds = inputKeys.map((inputKey) => {
            const inputId = candidateIdentifierForKey.get(inputKey);
            if (inputId === undefined) throw new IdentifierLookupConflictError(`Missing candidate input identifier for ${String(inputKey)}`);
            return inputId;
        });
        if (!arraysOfNodeIdentifiersEqual(normalizeInputEdges(sourceInputIds), normalizeInputEdges(candidateInputIds))) {
            conflictInvalidationCandidates.add(nodeKey);
        }
    }

    /** @type {Set<NodeKeyString>} */
    const deletedMaterializationKeys = new Set(conflictedKeys);
    const queue = [...conflictedKeys];
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

    /** @type {Set<NodeKeyString>} */
    const directInvalidationKeys = new Set();
    for (const nodeKey of conflictInvalidationCandidates) {
        if (!deletedMaterializationKeys.has(nodeKey)) directInvalidationKeys.add(nodeKey);
    }

    /** @type {Map<NodeKeyString, import('./value_clock').ValueClock>} */
    const finalConflictFrontierByKey = new Map(rootConflictFrontierByKey);
    for (const nodeKey of deletedMaterializationKeys) {
        finalConflictFrontierByKey.set(nodeKey, await joinedSourceFrontier(T, H, targetLookup, hostLookup, nodeKey));
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
        if (targetId !== undefined && targetId !== finalId) hasIdentifierReconciliation = true;
    }

    /** @type {Map<NodeIdentifier, NodeIdentifier[]>} */
    const mergedInputsMap = new Map();
    for (const [nodeKey, inputKeys] of candidateInputsByKey) {
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
        selectedSourceByKey,
        mergedInputsMap,
        conflictInvalidationCandidates,
        directInvalidationKeys,
        conflictedKeys,
        deletedMaterializationKeys,
        finalConflictFrontierByKey,
        finalIdentifierForKey,
        finalIdentifierLookup,
        hasIdentifierReconciliation,
    };
}

module.exports = { buildMergePlan };
