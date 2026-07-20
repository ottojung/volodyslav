/**
 * Merge validity preservation and reconstruction for incremental-graph merge.
 *
 * After node decisions are applied and the final graph state is assembled,
 * this module rebuilds the valid relation from the final merged inputs and
 * freshness, while transporting provenance-backed validity entries from both the
 * original target replica and the staged host replica.
 */


const { compareNodeIdentifier } = require('./node_identifier');
const { nodeIdentifierToString } = require('./types');
const { RAW_BATCH_CHUNK_SIZE } = require('./constants');
const { topologicalSortFromMap } = require('./topo_sort');

/** @typedef {import('./identifier_lookup').IdentifierLookup} IdentifierLookup */
/** @typedef {import('./root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */
/** @typedef {import('./types').Freshness} Freshness */
/** @typedef {'keep' | 'take' | 'invalidate' | 'delete'} MergeDecision */

/**
 * @typedef {object} SourceValueOrigin
 * @property {'source'} kind
 * @property {'target' | 'host'} side
 * @property {NodeIdentifier} sourceId
 */

/**
 * @typedef {SourceValueOrigin} ValueOrigin
 */

/**
 * Small helper around SchemaStorage.batch() that guarantees batch sizes never
 * exceed RAW_BATCH_CHUNK_SIZE while still allowing callers to build operations
 * incrementally.
 */
class ReplicaBatchWriter {
    /**
     * @param {SchemaStorage} storage
     */
    constructor(storage) {
        this._storage = storage;
        /** @type {Array<*>} */
        this._pendingOps = [];
    }

    /**
     * @param {Array<*>} operations
     * @returns {Promise<void>}
     */
    async pushAll(operations) {
        this._pendingOps.push(...operations);
        await this.flushCompleteChunks();
    }

    /**
     * @param {*} operation
     * @returns {Promise<void>}
     */
    async push(operation) {
        this._pendingOps.push(operation);
        await this.flushCompleteChunks();
    }

    /**
     * Flush full chunks and leave any partial chunk queued.
     * @returns {Promise<void>}
     */
    async flushCompleteChunks() {
        while (this._pendingOps.length >= RAW_BATCH_CHUNK_SIZE) {
            const chunk = this._pendingOps.slice(0, RAW_BATCH_CHUNK_SIZE);
            await this._storage.batch(chunk);
            this._pendingOps = this._pendingOps.slice(RAW_BATCH_CHUNK_SIZE);
        }
    }

    /**
     * Flush all queued operations. No-op when the queue is empty.
     * @returns {Promise<void>}
     */
    async flush() {
        await this.flushCompleteChunks();
        if (this._pendingOps.length === 0) {
            return;
        }
        await this._storage.batch(this._pendingOps);
        this._pendingOps = [];
    }
}

/**
 * Build the valueOriginByKey map from merge plan data.
 *
 * The map describes the provenance of every final stored value:
 * - { kind: "source", side, sourceId } if the final value is a byte-for-byte
 *   copy preserved from that side's source identifier.
 * @param {Map<NodeKeyString, 'keep' | 'take'>} initialDecisions
 * @param {Map<NodeKeyString, MergeDecision>} decisions
 * @param {IdentifierLookup} targetLookup
 * @param {IdentifierLookup} hostLookup
 * @param {Map<NodeKeyString, NodeIdentifier>} finalIdentifierForKey
 * @returns {Promise<Map<NodeKeyString, ValueOrigin>>}
 */
async function buildValueOriginByKey(
    initialDecisions,
    decisions,
    targetLookup,
    hostLookup,
    finalIdentifierForKey
) {
    /** @type {Map<NodeKeyString, ValueOrigin>} */
    const map = new Map();

    for (const [nodeKey, decision] of decisions) {
        if (decision === 'delete') continue;
        if (!finalIdentifierForKey.has(nodeKey)) continue;
        const initial = initialDecisions.get(nodeKey);
        if (initial === undefined) continue;
        const sourceSide = decision === 'invalidate' ? initial : decision;
        const sourceLookup = sourceSide === 'take' ? hostLookup : targetLookup;
        const sourceId = sourceLookup.keyToId.get(String(nodeKey));
        if (sourceId === undefined) continue;
        map.set(nodeKey, { kind: 'source', side: sourceSide === 'take' ? 'host' : 'target', sourceId });
    }

    return map;
}

/**
 * Check whether a ValueOrigin matches a specific source side and source identifier.
 * @param {ValueOrigin | undefined} origin
 * @param {'target' | 'host'} side
 * @param {NodeIdentifier} sourceId
 * @returns {boolean}
 */
function originMatches(origin, side, sourceId) {
    return origin !== undefined
        && origin.side === side
        && nodeIdentifierToString(origin.sourceId) === nodeIdentifierToString(sourceId);
}

/**
 * Check whether a NodeIdentifier is present in a list.
 * @param {NodeIdentifier[]} list
 * @param {NodeIdentifier} id
 * @returns {boolean}
 */
function containsIdentifier(list, id) {
    const idStr = nodeIdentifierToString(id);
    return list.some(item => nodeIdentifierToString(item) === idStr);
}

/**
 * @param {Map<string, NodeIdentifier[]>} validMap
 * @returns {Map<string, string[]>}
 */
function canonicalizeValidMap(validMap) {
    /** @type {Map<string, string[]>} */
    const canonical = new Map();
    for (const [depIdStr, dependents] of validMap) {
        if (dependents.length === 0) {
            continue;
        }
        const dependentStrings = Array.from(new Set(dependents.map(nodeIdentifierToString))).sort();
        if (dependentStrings.length > 0) {
            canonical.set(depIdStr, dependentStrings);
        }
    }
    return canonical;
}

/**
 * @param {SchemaStorage} targetStorage
 * @returns {Promise<Map<string, string[]>>}
 */
async function readCanonicalValidMap(targetStorage) {
    /** @type {Map<string, NodeIdentifier[]>} */
    const validMap = new Map();
    for await (const depId of targetStorage.valid.keys()) {
        validMap.set(nodeIdentifierToString(depId), await targetStorage.valid.get(depId) ?? []);
    }
    return canonicalizeValidMap(validMap);
}

/**
 * @param {Map<string, string[]>} left
 * @param {Map<string, string[]>} right
 * @returns {boolean}
 */
function canonicalValidMapsEqual(left, right) {
    if (left.size !== right.size) {
        return false;
    }
    for (const [depIdStr, leftDependents] of left) {
        const rightDependents = right.get(depIdStr);
        if (rightDependents === undefined || leftDependents.length !== rightDependents.length) {
            return false;
        }
        for (let index = 0; index < leftDependents.length; index += 1) {
            if (leftDependents[index] !== rightDependents[index]) {
                return false;
            }
        }
    }
    return true;
}

/**
 * Rebuild the valid relation and propagate freshness downgrades from merged inputs.
 *
 * Algorithm:
 * 1. Transport validity entries from both source sides based on source
 *    provenance for both endpoints.
 * 2. For every direct invalidation root: remove all incoming validity
 *    proofs and propagate freshness downstream without removing validity.
 * 3. For surviving up-to-date nodes: if an input is stale (propagated
 *    staleness), mark the node stale but preserve all its proofs. If a
 *    required transported proof is missing (cannot be justified), classify
 *    it as a new direct root: remove its incoming proofs and mark it stale.
 * 4. Write the rebuilt freshness and validity state.
 *
 * A validity proof valid[D].has(N) is transported from a source side only
 * when D and N both resolve through the same source side and their final values
 * preserve those exact source identifiers.
 * - D is still a structural input of N in the merged graph.
 *
 * @param {object} options
 * @param {SchemaStorage} options.targetStorage
 * @param {SchemaStorage} options.targetSourceStorage
 * @param {SchemaStorage} options.hostSourceStorage
 * @param {IdentifierLookup} options.targetLookup
 * @param {IdentifierLookup} options.hostLookup
 * @param {Map<NodeKeyString, NodeIdentifier>} options.finalIdentifierForKey
 * @param {Map<NodeIdentifier, NodeIdentifier[]>} options.mergedInputsMap
 * @param {Map<NodeKeyString, ValueOrigin>} options.valueOriginByKey
 * @param {Set<NodeIdentifier>} options.directInvalidationRoots
 * @returns {Promise<boolean>} Whether the canonical valid relation or any freshness record changed.
 */
async function rebuildMergedValidity({
    targetStorage,
    targetSourceStorage,
    hostSourceStorage,
    targetLookup,
    hostLookup,
    finalIdentifierForKey: finalIdForKey,
    mergedInputsMap,
    valueOriginByKey,
    directInvalidationRoots = new Set(),
}) {
    const oldCanonicalValidMap = await readCanonicalValidMap(targetStorage);

    /** @type {Map<string, NodeIdentifier[]>} */
    const validMap = new Map();
    /** @type {Map<string, NodeIdentifier>} */
    const depIdCache = new Map();

    /**
     * @param {'target' | 'host'} side
     * @param {SchemaStorage} sourceStorage
     * @param {IdentifierLookup} sourceLookup
     * @returns {Promise<void>}
     */
    async function transportValidityFromSide(side, sourceStorage, sourceLookup) {
        for await (const sourceDepId of sourceStorage.valid.keys()) {
            const sourceDependents = await sourceStorage.valid.get(sourceDepId) ?? [];

            const depIdStr = nodeIdentifierToString(sourceDepId);
            const depKey = sourceLookup.idToKey.get(depIdStr);
            if (depKey === undefined) continue;

            const finalDepId = finalIdForKey.get(depKey);
            if (finalDepId === undefined) continue;

            if (!originMatches(valueOriginByKey.get(depKey), side, sourceDepId)) continue;

            for (const sourceDependentId of sourceDependents) {
                const dependentIdStr = nodeIdentifierToString(sourceDependentId);
                const dependentKey = sourceLookup.idToKey.get(dependentIdStr);
                if (dependentKey === undefined) continue;

                const finalDependentId = finalIdForKey.get(dependentKey);
                if (finalDependentId === undefined) continue;

                if (!originMatches(valueOriginByKey.get(dependentKey), side, sourceDependentId)) continue;

                const finalInputs = mergedInputsMap.get(finalDependentId) ?? [];
                if (!containsIdentifier(finalInputs, finalDepId)) continue;

                const finalDepIdStr = nodeIdentifierToString(finalDepId);
                depIdCache.set(finalDepIdStr, finalDepId);
                let deps = validMap.get(finalDepIdStr);
                if (deps === undefined) {
                    deps = [];
                    validMap.set(finalDepIdStr, deps);
                }
                if (!containsIdentifier(deps, finalDependentId)) {
                    deps.push(finalDependentId);
                }
            }
        }
    }

    await transportValidityFromSide('target', targetSourceStorage, targetLookup);
    await transportValidityFromSide('host', hostSourceStorage, hostLookup);

    /** @type {Map<string, Freshness>} */
    const finalFreshness = new Map();
    /** @type {Map<string, NodeIdentifier>} */
    const finalIdentifierByString = new Map();
    for await (const nodeId of targetStorage.freshness.keys()) {
        const f = await targetStorage.freshness.get(nodeId);
        if (f !== undefined) {
            const nodeIdStr = nodeIdentifierToString(nodeId);
            finalFreshness.set(nodeIdStr, f);
            finalIdentifierByString.set(nodeIdStr, nodeId);
        }
    }
    for (const nodeIdentifier of mergedInputsMap.keys()) {
        finalIdentifierByString.set(nodeIdentifierToString(nodeIdentifier), nodeIdentifier);
    }

    // Step 2: Handle direct invalidation roots.
    // For each directly invalidated root: remove all incoming validity proofs,
    // mark stale, and propagate freshness downstream preserving validity edges.
    let freshnessChanged = false;
    for (const root of directInvalidationRoots) {
        const rootIdStr = nodeIdentifierToString(root);
        if (finalFreshness.get(rootIdStr) !== 'potentially-outdated') {
            finalFreshness.set(rootIdStr, 'potentially-outdated');
            freshnessChanged = true;
        }
        removeIncomingValidity(mergedInputsMap, validMap, root);
        const rootDependents = validMap.get(rootIdStr) ?? [];
        for (const dependent of rootDependents) {
            const depStr = nodeIdentifierToString(dependent);
            if (finalFreshness.get(depStr) !== 'potentially-outdated') {
                finalFreshness.set(depStr, 'potentially-outdated');
                freshnessChanged = true;
            }
        }
    }

    // Step 3: Propagate staleness and handle missing-proof roots.
    // For every surviving up-to-date node: if an input is stale (propagated
    // staleness), mark the node stale but preserve all its proofs. If a
    // required transported proof is missing, classify it as a new direct
    // root: remove its incoming proofs and mark it stale.
    let changed = true;
    while (changed) {
        changed = false;
        for (const nodeIdentifier of topologicalSortFromMap(mergedInputsMap)) {
            const nodeIdStr = nodeIdentifierToString(nodeIdentifier);
            if (finalFreshness.get(nodeIdStr) !== 'up-to-date') continue;

            const requiredInputs = mergedInputsMap.get(nodeIdentifier) ?? [];
            let staleInput = false;
            let missingProof = false;
            for (const depId of requiredInputs) {
                const depIdStr = nodeIdentifierToString(depId);
                if (finalFreshness.get(depIdStr) !== 'up-to-date') {
                    staleInput = true;
                }
                const dependents = validMap.get(depIdStr) ?? [];
                if (!dependents.some(dependent => nodeIdentifierToString(dependent) === nodeIdStr)) {
                    missingProof = true;
                }
            }

            if (staleInput) {
                // Propagated staleness — preserve all proofs
                finalFreshness.set(nodeIdStr, 'potentially-outdated');
                freshnessChanged = true;
                changed = true;
            } else if (missingProof) {
                // Missing proof — classify as direct root
                finalFreshness.set(nodeIdStr, 'potentially-outdated');
                freshnessChanged = true;
                changed = true;
                removeIncomingValidity(mergedInputsMap, validMap, nodeIdentifier);
            }
        }
    }

    // Step 4: Preserve only transported proofs for surviving materializations.
    // Do NOT mint proofs that were not transported. Previously transported
    // proofs remain in validMap; no mandatory creation is performed.

    const writer = new ReplicaBatchWriter(targetStorage);
    for (const [nodeIdStr, freshness] of finalFreshness) {
        const nodeIdentifier = finalIdentifierByString.get(nodeIdStr);
        if (nodeIdentifier !== undefined) {
            await writer.push(targetStorage.freshness.putOp(nodeIdentifier, freshness));
        }
    }

    await targetStorage.valid.clear();
    for (const [depIdStr, dependents] of validMap) {
        const depId = depIdCache.get(depIdStr);
        if (depId !== undefined && dependents.length > 0) {
            dependents.sort(compareNodeIdentifier);
            await writer.push(targetStorage.valid.putOp(depId, dependents));
        }
    }
    await writer.flush();
    const validityChanged = !canonicalValidMapsEqual(oldCanonicalValidMap, canonicalizeValidMap(validMap));
    return validityChanged || freshnessChanged;
}

/**
 * Remove N from every input's validity set.
 * @param {Map<NodeIdentifier, NodeIdentifier[]>} mergedInputsMap
 * @param {Map<string, NodeIdentifier[]>} validMap
 * @param {NodeIdentifier} nodeIdentifier
 */
function removeIncomingValidity(mergedInputsMap, validMap, nodeIdentifier) {
    const nodeIdStr = nodeIdentifierToString(nodeIdentifier);
    const inputs = mergedInputsMap.get(nodeIdentifier) ?? [];
    for (const input of inputs) {
        const inputStr = nodeIdentifierToString(input);
        const dependents = validMap.get(inputStr);
        if (dependents === undefined) continue;
        const filtered = dependents.filter(d => nodeIdentifierToString(d) !== nodeIdStr);
        if (filtered.length === 0) {
            validMap.delete(inputStr);
        } else {
            validMap.set(inputStr, filtered);
        }
    }
}

module.exports = {
    rebuildMergedValidity,
    buildValueOriginByKey,
    ReplicaBatchWriter,
};
