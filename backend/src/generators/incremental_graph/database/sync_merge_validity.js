/**
 * Merge validity preservation and reconstruction for incremental-graph merge.
 *
 * After node outcomes are applied and the final graph state is assembled,
 * this module rebuilds the valid relation from the final merged inputs and
 * freshness, while transporting provenance-backed validity entries from both the
 * original target replica and the staged host replica.
 *
 * Missing transportable proofs are classified during merge planning. Validity
 * reconstruction expects that classification to be complete. Discovering a
 * missing proof during reconstruction throws UnplannedMissingValidityProofError.
 * Reconstruction does not itself create a new direct invalidation root.
 */


const { compareNodeIdentifier } = require('./node_identifier');
const { nodeIdentifierToString } = require('./types');
const { sourceRepresentsFinalVersion } = require('./sync_merge_version_identity');
const { RAW_BATCH_CHUNK_SIZE } = require('./constants');
const { topologicalSortFromMap } = require('./topo_sort');

/** @typedef {import('./identifier_lookup').IdentifierLookup} IdentifierLookup */
/** @typedef {import('./root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */
/** @typedef {import('./types').Freshness} Freshness */
/** @typedef {'keep' | 'take' | 'invalidate' | 'delete'} MergeOutcome */

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

class UnplannedMissingValidityProofError extends Error {
    /**
     * @param {NodeIdentifier} nodeIdentifier
     */
    constructor(nodeIdentifier) {
        super(`Merge planning missed a required validity proof for ${String(nodeIdentifier)}`);
        this.name = 'UnplannedMissingValidityProofError';
        this.nodeIdentifier = nodeIdentifier;
    }
}

/**
 * Compute transported validity proofs for a final graph from source provenance.
 * @param {object} options
 * @param {SchemaStorage} options.targetSourceStorage
 * @param {SchemaStorage} options.hostSourceStorage
 * @param {IdentifierLookup} options.targetLookup
 * @param {IdentifierLookup} options.hostLookup
 * @param {Map<NodeKeyString, NodeIdentifier>} options.finalIdentifierForKey
 * @param {Map<NodeIdentifier, NodeIdentifier[]>} options.mergedInputsMap
 * @param {Map<NodeKeyString, 'keep' | 'take'>} options.selectedSideByKey
 * @param {Set<NodeKeyString>} options.equalVersionKeys
 * @returns {Promise<{ validMap: Map<string, NodeIdentifier[]>, depIdCache: Map<string, NodeIdentifier> }>}
 */
async function buildTransportedValidityPlan({
    targetSourceStorage,
    hostSourceStorage,
    targetLookup,
    hostLookup,
    finalIdentifierForKey: finalIdForKey,
    mergedInputsMap,
    selectedSideByKey,
    equalVersionKeys,
}) {
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
            if (!sourceRepresentsFinalVersion({
                side: side === 'target' ? 'keep' : 'take',
                sourceId: sourceDepId,
                nodeKey: depKey,
                selectedSideByKey,
                finalIdentifierForKey: finalIdForKey,
                equalVersionKeys,
            })) continue;

            for (const sourceDependentId of sourceDependents) {
                const dependentIdStr = nodeIdentifierToString(sourceDependentId);
                const dependentKey = sourceLookup.idToKey.get(dependentIdStr);
                if (dependentKey === undefined) continue;
                const finalDependentId = finalIdForKey.get(dependentKey);
                if (finalDependentId === undefined) continue;
                if (!sourceRepresentsFinalVersion({
                    side: side === 'target' ? 'keep' : 'take',
                    sourceId: sourceDependentId,
                    nodeKey: dependentKey,
                    selectedSideByKey,
                    finalIdentifierForKey: finalIdForKey,
                    equalVersionKeys,
                })) continue;
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
    return { validMap, depIdCache };
}
/**
 * Rebuild the valid relation and propagate freshness downgrades from merged inputs.
 *
 * Algorithm:
 * 1. Transport validity entries from both source sides based on source
 *    provenance for both endpoints.
 * 2. For every direct invalidation root: remove all incoming validity
 *    proofs and mark stale. The single topological traversal classifies
 *    all descendants.
 * 3. Single roots-to-leaves traversal of surviving up-to-date nodes:
 *    if a required transported proof is unexpectedly missing, throw an
 *    implementation inconsistency error. Otherwise if an input is stale, mark
 *    stale while preserving all proofs.
 * 4. Compare final validity against stored state. Write dirty freshness
 *    and rewritten validity only when they have actually changed.
 *
 * A validity proof valid[D].has(N) is transported from a source side only
 * when both endpoints' source identifiers represent the final version through
 * the canonical source-version identity relation (sourceRepresentsFinalVersion).
 * Both endpoints come from the same source replica. Their final stored byte
 * origins do not need to be that source replica when exact-version copies
 * represent the same temporary semantic versions.
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
 * @param {Set<NodeIdentifier>} options.directInvalidationRoots
 * @param {Map<NodeKeyString, 'keep' | 'take'>} options.selectedSideByKey
 * @param {Set<NodeKeyString>} options.equalVersionKeys
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
    directInvalidationRoots,
    selectedSideByKey,
    equalVersionKeys,
}) {
    const oldCanonicalValidMap = await readCanonicalValidMap(targetStorage);

    const { validMap, depIdCache } = await buildTransportedValidityPlan({
        targetSourceStorage,
        hostSourceStorage,
        targetLookup,
        hostLookup,
        finalIdentifierForKey: finalIdForKey,
        mergedInputsMap,
        selectedSideByKey,
        equalVersionKeys,
    });

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
    // mark stale, and let the topological traversal classify all descendants.
    /** @type {Set<string>} */
    const dirtyFreshness = new Set();
    let freshnessChanged = false;
    for (const root of directInvalidationRoots) {
        const rootIdStr = nodeIdentifierToString(root);
        if (finalFreshness.get(rootIdStr) !== 'potentially-outdated') {
            finalFreshness.set(rootIdStr, 'potentially-outdated');
            dirtyFreshness.add(rootIdStr);
            freshnessChanged = true;
        }
        removeIncomingValidity(mergedInputsMap, validMap, root);
    }

    // Step 3: Propagate staleness and detect unplanned missing proofs.
    // For every surviving up-to-date node: if an input is stale (propagated
    // staleness), mark the node stale but preserve all its proofs. If a
    // required transported proof is unexpectedly missing, throw an
    // UnplannedMissingValidityProofError — missing-proof classification must
    // have been handled during merge planning.
    //
    // A single roots-to-leaves traversal is sufficient because:
    // - every input of N has already been processed when N is visited;
    // - if N becomes stale, every structural dependent of N occurs later;
    // - removing N's incoming proofs does not change any ancestor's state.
    const topologicalOrder = topologicalSortFromMap(mergedInputsMap);
    for (const nodeIdentifier of topologicalOrder) {
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

        if (missingProof) {
            throw new UnplannedMissingValidityProofError(nodeIdentifier);
        } else if (staleInput) {
            // Propagated staleness — preserve all proofs
            finalFreshness.set(nodeIdStr, 'potentially-outdated');
            dirtyFreshness.add(nodeIdStr);
            freshnessChanged = true;
        }
    }

    // Step 4: Preserve only transported proofs for surviving materializations.
    // Do NOT mint proofs that were not transported. Previously transported
    // proofs remain in validMap; no mandatory creation is performed.

    // Step 4: Compare final validity against the stored state before mutating.
    const finalCanonicalValidMap = canonicalizeValidMap(validMap);
    const validityChanged = !canonicalValidMapsEqual(oldCanonicalValidMap, finalCanonicalValidMap);

    const writer = new ReplicaBatchWriter(targetStorage);
    for (const nodeIdStr of dirtyFreshness) {
        const freshness = finalFreshness.get(nodeIdStr);
        const nodeIdentifier = finalIdentifierByString.get(nodeIdStr);
        if (freshness !== undefined && nodeIdentifier !== undefined) {
            await writer.push(targetStorage.freshness.putOp(nodeIdentifier, freshness));
        }
    }

    if (validityChanged) {
        await targetStorage.valid.clear();
        for (const [depIdStr, dependents] of validMap) {
            const depId = depIdCache.get(depIdStr);
            if (depId !== undefined && dependents.length > 0) {
                dependents.sort(compareNodeIdentifier);
                await writer.push(targetStorage.valid.putOp(depId, dependents));
            }
        }
    }
    await writer.flush();
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
    ReplicaBatchWriter,
    buildTransportedValidityPlan,
    UnplannedMissingValidityProofError,
};
