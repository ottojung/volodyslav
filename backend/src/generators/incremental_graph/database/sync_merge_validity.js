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
 * @returns {Promise<void>}
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

            const depOrigin = valueOriginByKey.get(depKey);
            if (!originMatches(depOrigin, side, sourceDepId)) continue;

            for (const sourceDependentId of sourceDependents) {
                const dependentIdStr = nodeIdentifierToString(sourceDependentId);
                const dependentKey = sourceLookup.idToKey.get(dependentIdStr);
                if (dependentKey === undefined) continue;

                const finalDependentId = finalIdForKey.get(dependentKey);
                if (finalDependentId === undefined) continue;

                const dependentOrigin = valueOriginByKey.get(dependentKey);
                if (!originMatches(dependentOrigin, side, sourceDependentId)) continue;

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
}

module.exports = {
    rebuildMergedValidity,
    buildValueOriginByKey,
    ReplicaBatchWriter,
};
