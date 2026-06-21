/**
 * Merge validity preservation and reconstruction for incremental-graph merge.
 *
 * After node decisions are applied and the final graph state is assembled,
 * this module rebuilds the valid relation from the final merged inputs and
 * freshness, while preserving compatible validity entries for kept nodes.
 */


const { compareNodeIdentifier } = require('./node_identifier');
const { nodeIdentifierToString } = require('./types');
const { RAW_BATCH_CHUNK_SIZE } = require('./constants');

/** @typedef {import('./identifier_lookup').IdentifierLookup} IdentifierLookup */
/** @typedef {import('./root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */
/** @typedef {'keep' | 'take' | 'invalidate'} MergeDecision */

/**
 * @typedef {object} SourceValueOrigin
 * @property {'source'} kind
 * @property {'target' | 'host'} side
 * @property {NodeIdentifier} sourceId
 */

/**
 * @typedef {SourceValueOrigin | { kind: 'none' }} ValueOrigin
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
 * - { kind: "none" } if the final value is deleted, absent, or not a preserved
 *   copy from either source.
 *
 * @param {Map<NodeKeyString, 'keep' | 'take'>} initialDecisions
 * @param {Map<NodeKeyString, MergeDecision>} decisions
 * @param {IdentifierLookup} targetLookup
 * @param {IdentifierLookup} hostLookup
 * @param {Set<NodeKeyString>} directlyReloweredNodes
 * @param {SchemaStorage} targetStorage
 * @param {SchemaStorage} targetSourceStorage
 * @param {SchemaStorage} hostSourceStorage
 * @param {Map<NodeKeyString, NodeIdentifier>} finalIdentifierForKey
 * @returns {Promise<Map<NodeKeyString, ValueOrigin>>}
 */
async function buildValueOriginByKey(
    initialDecisions,
    decisions,
    targetLookup,
    hostLookup,
    directlyReloweredNodes,
    targetStorage,
    targetSourceStorage,
    hostSourceStorage,
    finalIdentifierForKey
) {
    /** @type {Map<NodeKeyString, ValueOrigin>} */
    const map = new Map();

    for (const [nodeKey] of decisions) {
        if (directlyReloweredNodes.has(nodeKey)) {
            map.set(nodeKey, { kind: 'none' });
            continue;
        }
        const finalId = finalIdentifierForKey.get(nodeKey);
        if (finalId === undefined || await targetStorage.values.get(finalId) === undefined) {
            map.set(nodeKey, { kind: 'none' });
            continue;
        }
        const initial = initialDecisions.get(nodeKey);
        if (initial === undefined) {
            map.set(nodeKey, { kind: 'none' });
            continue;
        }
        const decision = decisions.get(nodeKey);
        const sourceSide = decision === 'invalidate' ? initial : decision;
        const sourceLookup = sourceSide === 'take' ? hostLookup : targetLookup;
        const sourceStorage = sourceSide === 'take' ? hostSourceStorage : targetSourceStorage;
        const sourceId = sourceLookup.keyToId.get(String(nodeKey));
        if (sourceId === undefined || await sourceStorage.values.get(sourceId) === undefined) {
            map.set(nodeKey, { kind: 'none' });
            continue;
        }
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
        && origin.kind === 'source'
        && origin.side === side
        && nodeIdentifierToString(origin.sourceId) === nodeIdentifierToString(sourceId);
}

/**
 * Compare stored graph values by JSON-like structure without observing
 * prototypes or mutating either value.
 * @param {*} left
 * @param {*} right
 * @returns {boolean}
 */
function storageValuesEqual(left, right) {
    if (Object.is(left, right)) {
        return true;
    }
    if (left === null || right === null) {
        return false;
    }
    if (typeof left !== 'object' || typeof right !== 'object') {
        return false;
    }
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right)) {
            return false;
        }
        if (left.length !== right.length) {
            return false;
        }
        for (let index = 0; index < left.length; index += 1) {
            if (!storageValuesEqual(left[index], right[index])) {
                return false;
            }
        }
        return true;
    }

    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) {
        return false;
    }
    for (let index = 0; index < leftKeys.length; index += 1) {
        const key = leftKeys[index];
        const rightKey = rightKeys[index];
        if (key === undefined || key !== rightKey) {
            return false;
        }
        if (!storageValuesEqual(left[key], right[key])) {
            return false;
        }
    }
    return true;
}

/**
 * Check whether a source-side value can justify transporting a source-side
 * validity endpoint onto the final endpoint.
 * @param {object} options
 * @param {'target' | 'host'} options.side
 * @param {SchemaStorage} options.sourceStorage
 * @param {NodeIdentifier} options.sourceId
 * @param {NodeKeyString} options.sourceKey
 * @param {NodeIdentifier} options.finalId
 * @param {Map<NodeKeyString, ValueOrigin>} options.valueOriginByKey
 * @param {SchemaStorage} options.targetStorage
 * @returns {Promise<boolean>}
 */
async function sourceValueCompatibleWithFinal({
    side,
    sourceStorage,
    sourceId,
    sourceKey,
    finalId,
    valueOriginByKey,
    targetStorage,
}) {
    if (originMatches(valueOriginByKey.get(sourceKey), side, sourceId)) {
        return true;
    }

    const sourceValue = await sourceStorage.values.get(sourceId);
    if (sourceValue === undefined) {
        return false;
    }
    const finalValue = await targetStorage.values.get(finalId);
    if (finalValue === undefined) {
        return false;
    }
    return storageValuesEqual(sourceValue, finalValue);
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
 * Rebuild the valid relation from provenance-based value origin transport.
 *
 * Algorithm:
 * 1. Transport validity entries from both source sides based on value origin.
 * 2. Add mandatory flags for every up-to-date node.
 * 3. Clear the existing valid sublevel and write the rebuilt relation.
 *
 * A validity proof valid[D].has(N) is transported from a source side only when:
 * - Both D and N have value origin from that same side with matching source identifiers.
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
 * @returns {Promise<boolean>} Whether the canonical valid relation changed.
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

            if (!await sourceValueCompatibleWithFinal({
                side,
                sourceStorage,
                sourceId: sourceDepId,
                sourceKey: depKey,
                finalId: finalDepId,
                valueOriginByKey,
                targetStorage,
            })) continue;

            for (const sourceDependentId of sourceDependents) {
                const dependentIdStr = nodeIdentifierToString(sourceDependentId);
                const dependentKey = sourceLookup.idToKey.get(dependentIdStr);
                if (dependentKey === undefined) continue;

                const finalDependentId = finalIdForKey.get(dependentKey);
                if (finalDependentId === undefined) continue;

                if (!await sourceValueCompatibleWithFinal({
                    side,
                    sourceStorage,
                    sourceId: sourceDependentId,
                    sourceKey: dependentKey,
                    finalId: finalDependentId,
                    valueOriginByKey,
                    targetStorage,
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

    for await (const nodeIdentifier of targetStorage.values.keys()) {
        const freshness = await targetStorage.freshness.get(nodeIdentifier);
        if (freshness !== 'up-to-date') continue;

        const requiredInputs = mergedInputsMap.get(nodeIdentifier) ?? [];
        const nodeIdStr = nodeIdentifierToString(nodeIdentifier);
        for (const depId of requiredInputs) {
            const depIdStr = nodeIdentifierToString(depId);
            depIdCache.set(depIdStr, depId);
            const dependents = validMap.get(depIdStr) ?? [];
            validMap.set(depIdStr, dependents);
            if (!dependents.some(dependent => nodeIdentifierToString(dependent) === nodeIdStr)) {
                dependents.push(nodeIdentifier);
            }
        }
    }

    await targetStorage.valid.clear();

    const writer = new ReplicaBatchWriter(targetStorage);
    for (const [depIdStr, dependents] of validMap) {
        const depId = depIdCache.get(depIdStr);
        if (depId !== undefined && dependents.length > 0) {
            dependents.sort(compareNodeIdentifier);
            await writer.push(targetStorage.valid.putOp(depId, dependents));
        }
    }
    await writer.flush();
    return !canonicalValidMapsEqual(oldCanonicalValidMap, canonicalizeValidMap(validMap));
}

module.exports = {
    rebuildMergedValidity,
    buildValueOriginByKey,
    ReplicaBatchWriter,
    storageValuesEqual,
};
