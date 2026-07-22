const { topologicalSortFromMap } = require('./topo_sort');
const { makeIdentifierLookup } = require('./identifier_lookup');
const { IdentifierLookupConflictError } = require('./replica_errors');

const { GRAPH_SCHEME_KEY, parseGraphScheme, semanticInputKeys } = require('./graph_scheme');
const { normalizeInputEdges } = require('./input_edges');
const { compareIsoTimestamps } = require('./sync_merge_timestamps');
const { compareNodeIdentifier } = require('./node_identifier');
const { sourceRepresentsFinalVersion } = require('./sync_merge_version_identity');
const { compareMaterializationCandidates, makeMaterializationCandidate } = require('./sync_merge_candidates');

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
 * Find deletion roots among direct invalidation candidates under the temporary
 * pairwise policy. Candidates with at most one distinct semantic input retain
 * oldValue (hard invalidation). Candidates with multiple distinct inputs are
 * deleted.
 *
 * FIXME(#1521): This arity-based invalidate-vs-delete rule is deliberately
 * conservative. The current pairwise database state does not retain exact
 * historical input-version provenance. Until the graph journal provides that
 * provenance, direct invalidation candidates with at most one distinct semantic
 * input retain oldValue, while candidates with multiple distinct inputs are
 * deleted. Replace this classifier with journal-backed coherent-history analysis.
 *
 * @param {Set<NodeKeyString>} directInvalidationCandidateKeys
 * @param {Map<NodeKeyString, NodeKeyString[]>} selectedInputsByKey
 * @returns {Set<NodeKeyString>}
 */
function findDeletionRoots(directInvalidationCandidateKeys, selectedInputsByKey) {
    /** @type {Set<NodeKeyString>} */
    const deletionRootKeys = new Set();
    for (const nodeKey of directInvalidationCandidateKeys) {
        if (countDistinctSemanticInputs(selectedInputsByKey.get(nodeKey) ?? []) > 1) {
            deletionRootKeys.add(nodeKey);
        }
    }
    return deletionRootKeys;
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
 * Compute the semantic merge plan, then lower its graph back to final storage identifiers.
 *
 * Returns the canonical planning result:
 * - `selectedSideByKey`: per-node source selection (keep or take)
 * - `outcomeByKey`: per-node final outcome (keep, take, invalidate, delete)
 * - `finalIdentifierForKey`: surviving node identifiers
 * - `finalIdentifierLookup`: bijective final lookup
 * - `mergedInputsMap`: final lowered input edges
 * - `hasIdentifierReconciliation`: whether identifiers changed
 * - `sameTimestampAndIdentifierKeys`: set of keys with matching timestamp and identifier across sides
 *
 * @param {SchemaStorage} T
 * @param {SchemaStorage} H
 * @param {IdentifierLookup} targetLookup
 * @param {IdentifierLookup} hostLookup
 * @param {string} targetSourceFingerprint
 * @param {string} hostSourceFingerprint
 * @returns {Promise<{
 *   selectedSideByKey: Map<NodeKeyString, 'keep' | 'take'>,
 *   outcomeByKey: Map<NodeKeyString, 'keep' | 'take' | 'invalidate' | 'delete'>,
 *   mergedInputsMap: Map<NodeIdentifier, NodeIdentifier[]>,
 *   finalIdentifierForKey: Map<NodeKeyString, NodeIdentifier>,
 *   finalIdentifierLookup: IdentifierLookup,
 *   hasIdentifierReconciliation: boolean,
 *   sameTimestampAndIdentifierKeys: Set<NodeKeyString>
 * }>} 
 */
async function buildMergePlan(T, H, targetLookup, hostLookup, targetSourceFingerprint, hostSourceFingerprint) {
    const targetScheme = parseGraphScheme(await T.global.get(GRAPH_SCHEME_KEY));
    const hostScheme = parseGraphScheme(await H.global.get(GRAPH_SCHEME_KEY));

    /** @type {Map<NodeKeyString, 'keep' | 'take'>} */
    const selectedSideByKey = new Map();
    /** @type {Set<NodeKeyString>} */
    const forceKeepRoots = new Set();
    /** @type {Set<NodeKeyString>} */
    const forceTakeRoots = new Set();
    /** @type {NodeKeyString[]} */
    const allNodeKeys = Array.from(new Set([
        ...targetLookup.idToKey.values(),
        ...hostLookup.idToKey.values(),
    ])).sort();

    /** @type {Set<NodeKeyString>} */
    const sameTimestampAndIdentifierKeys = new Set();
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
        if (targetTimestamps === undefined) throw new IdentifierLookupConflictError(`Target materialized node ${String(targetId)} has no timestamps entry`);
        if (hostTimestamps === undefined) throw new IdentifierLookupConflictError(`Host materialized node ${String(hostId)} has no timestamps entry`);
        const sameTimestampAndIdentifier = compareIsoTimestamps(targetTimestamps.modifiedAt, hostTimestamps.modifiedAt) === 0
            && compareNodeIdentifier(targetId, hostId) === 0;
        const cmp = compareMaterializationCandidates(
            makeMaterializationCandidate(targetId, targetTimestamps.modifiedAt, targetSourceFingerprint),
            makeMaterializationCandidate(hostId, hostTimestamps.modifiedAt, hostSourceFingerprint)
        );
        if (cmp >= 0) {
            selectedSideByKey.set(nodeKey, 'keep');
            if (cmp > 0) forceKeepRoots.add(nodeKey);
        } else {
            selectedSideByKey.set(nodeKey, 'take');
            forceTakeRoots.add(nodeKey);
        }
        if (sameTimestampAndIdentifier) sameTimestampAndIdentifierKeys.add(nodeKey);
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
    for (const [nodeKey, inputKeys] of selectedInputsByKey) {
        for (const inputKey of inputKeys) {
            const dependents = selectedDependentsByKey.get(inputKey) ?? new Set();
            dependents.add(nodeKey);
            selectedDependentsByKey.set(inputKey, dependents);
        }
        const selectedSide = selectedSideByKey.get(nodeKey);
        if (selectedSide === undefined) continue;
        const lookup = selectedSide === 'take' ? hostLookup : targetLookup;
        const distinctInputKeys = [...new Set(inputKeys)];
        for (const inputKey of distinctInputKeys) {
            const sourceId = lookup.keyToId.get(String(inputKey));
            const finalId = provisionalIdentifierForKey.get(inputKey);
            if (sourceId === undefined || finalId === undefined) {
                directInvalidationCandidateKeys.add(nodeKey);
                break;
            }
            if (!sourceRepresentsFinalVersion({ side: selectedSide, sourceId, nodeKey: inputKey, selectedSideByKey, finalIdentifierForKey: provisionalIdentifierForKey })) {
                directInvalidationCandidateKeys.add(nodeKey);
                break;
            }
        }
    }

    // Matching materialization coordinates use conservative freshness: any
    // stale source prevents the final selected record from remaining up-to-date.
    for (const nodeKey of sameTimestampAndIdentifierKeys) {
        const targetId = targetLookup.keyToId.get(String(nodeKey));
        const hostId = hostLookup.keyToId.get(String(nodeKey));
        if (targetId === undefined || hostId === undefined) continue;
        const selectedSide = selectedSideByKey.get(nodeKey);
        const selectedFreshness = selectedSide === 'take' ? await H.freshness.get(hostId) : await T.freshness.get(targetId);
        const targetFreshness = await T.freshness.get(targetId);
        const hostFreshness = await H.freshness.get(hostId);
        if (selectedFreshness === 'up-to-date' && (targetFreshness !== 'up-to-date' || hostFreshness !== 'up-to-date')) {
            directInvalidationCandidateKeys.add(nodeKey);
        }
    }

    const deletionRootKeys = findDeletionRoots(directInvalidationCandidateKeys, selectedInputsByKey);
    const deletedMaterializationKeys = expandStructuralDeletionClosure(deletionRootKeys, selectedDependentsByKey);
    /** @type {Map<NodeKeyString, NodeIdentifier>} */
    const finalIdentifierForKey = new Map();
    for (const [nodeKey, identifier] of provisionalIdentifierForKey) {
        if (!deletedMaterializationKeys.has(nodeKey)) finalIdentifierForKey.set(nodeKey, identifier);
    }

    /** @type {Map<NodeKeyString, 'keep' | 'take' | 'invalidate' | 'delete'>} */
    const outcomeByKey = new Map();
    for (const [nodeKey, selectedSide] of selectedSideByKey) {
        if (deletedMaterializationKeys.has(nodeKey)) outcomeByKey.set(nodeKey, 'delete');
        else if (directInvalidationCandidateKeys.has(nodeKey) && !deletedMaterializationKeys.has(nodeKey)) outcomeByKey.set(nodeKey, 'invalidate');
        else outcomeByKey.set(nodeKey, selectedSide);
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
        selectedSideByKey,
        outcomeByKey,
        mergedInputsMap,
        finalIdentifierForKey,
        finalIdentifierLookup,
        hasIdentifierReconciliation,
        sameTimestampAndIdentifierKeys,
    };
}

module.exports = { buildMergePlan };
