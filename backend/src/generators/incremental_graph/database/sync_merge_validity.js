/**
 * Merge validity preservation and reconstruction for incremental-graph merge.
 *
 * After node decisions are applied and the final graph state is assembled,
 * this module rebuilds the valid relation from the final merged inputs and
 * freshness, while preserving compatible validity entries for kept nodes.
 */

const { readInputRecord } = require('./input_record');
const { compareNodeIdentifier } = require('./node_identifier');
const { nodeIdentifierToString } = require('./types');
const { RAW_BATCH_CHUNK_SIZE } = require('./constants');

/** @typedef {import('./identifier_lookup').IdentifierLookup} IdentifierLookup */
/** @typedef {import('./root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */
/** @typedef {'keep' | 'take' | 'invalidate'} MergeDecision */

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
 * Rebuild the valid relation from the final merged graph state.
 *
 * 1. Capture validity entries currently present in the merge target.
 * 2. Preserve compatible valid[D].has(N) entries for kept nodes whose value
 *    identity is unchanged and whose input D's value identity is unchanged.
 * 3. Remove entries for deleted/discarded identifiers, or entries where the
 *    dependent's inputs no longer contain the dependency.
 * 4. Remove entries for nodes whose stored value was changed, taken from an
 *    incompatible side, or invalidated.
 * 5. Add required missing valid flags for every up-to-date node according
 *    to the invariant.
 *
 * @param {SchemaStorage} targetStorage
 * @param {Map<NodeKeyString, MergeDecision>} decisions
 * @param {Map<NodeKeyString, 'keep' | 'take'>} initialDecisions
 * @param {Map<NodeKeyString, NodeIdentifier>} finalIdentifierForKey
 * @param {Map<NodeIdentifier, NodeIdentifier[]>} mergedInputsMap
 * @param {IdentifierLookup} targetLookup
 * @returns {Promise<void>}
 */
async function preserveAndRebuildValidity(
    targetStorage,
    decisions,
    initialDecisions,
    finalIdentifierForKey,
    mergedInputsMap,
    targetLookup
) {
    /** @type {Map<string, NodeIdentifier[]>} */
    const previousValid = new Map();
    for await (const depId of targetStorage.valid.keys()) {
        const dependents = await targetStorage.valid.get(depId);
        if (dependents !== undefined) {
            previousValid.set(nodeIdentifierToString(depId), dependents);
        }
    }

    await targetStorage.valid.clear();

    /** @type {Map<string, NodeIdentifier[]>} */
    const validMap = new Map();
    /** @type {Map<string, NodeIdentifier>} */
    const depIdCache = new Map();

    for (const [depIdStr, dependents] of previousValid) {
        const depNodeKey = targetLookup.idToKey.get(depIdStr);
        if (depNodeKey === undefined) continue;
        const finalDepId = finalIdentifierForKey.get(depNodeKey);
        if (finalDepId === undefined) continue;

        const depDecision = decisions.get(depNodeKey);
        const depInitial = initialDecisions.get(depNodeKey);
        if (depDecision !== 'keep' || depInitial !== 'keep') continue;

        for (const dependent of dependents) {
            const depStr = nodeIdentifierToString(dependent);
            const depNodeKey2 = targetLookup.idToKey.get(depStr);
            if (depNodeKey2 === undefined) continue;
            const finalDepId2 = finalIdentifierForKey.get(depNodeKey2);
            if (finalDepId2 === undefined) continue;

            const dep2Decision = decisions.get(depNodeKey2);
            const dep2Initial = initialDecisions.get(depNodeKey2);
            if (dep2Decision !== 'keep' || dep2Initial !== 'keep') continue;

            const dep2Inputs = mergedInputsMap.get(finalDepId2) ?? [];
            if (!dep2Inputs.some(id => nodeIdentifierToString(id) === nodeIdentifierToString(finalDepId))) {
                continue;
            }

            const finalDepIdStr = nodeIdentifierToString(finalDepId);
            depIdCache.set(finalDepIdStr, finalDepId);
            let deps = validMap.get(finalDepIdStr) ?? [];
            validMap.set(finalDepIdStr, deps);
            if (!deps.some(d => nodeIdentifierToString(d) === nodeIdentifierToString(finalDepId2))) {
                deps.push(finalDepId2);
            }
        }
    }

    for await (const nodeIdentifier of targetStorage.inputs.keys()) {
        const freshness = await targetStorage.freshness.get(nodeIdentifier);
        if (freshness !== "up-to-date") {
            continue;
        }
        const inputs = readInputRecord(await targetStorage.inputs.get(nodeIdentifier));
        const nodeIdStr = nodeIdentifierToString(nodeIdentifier);
        for (const depId of inputs) {
            const depIdStr = nodeIdentifierToString(depId);
            depIdCache.set(depIdStr, depId);
            let dependents = validMap.get(depIdStr) ?? [];
            validMap.set(depIdStr, dependents);
            if (!dependents.some(d => nodeIdentifierToString(d) === nodeIdStr)) {
                dependents.push(nodeIdentifier);
            }
        }
    }

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
    preserveAndRebuildValidity,
    ReplicaBatchWriter,
};
