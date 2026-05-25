/**
 * Graph state management with transaction model for volatile-persistent consistency.
 *
 * This module implements the transaction model specified in:
 * docs/specs/incremental-graph-volatile-consistency.md
 *
 * Key concepts:
 * - A Transaction groups: batch (LevelDB batch accumulator with read-your-writes)
 *   + identifierLookup (working copy)
 * - A graph mutex serializes all operations
 * - createTransaction() reads _computed.identifierLookup and creates a fresh batch
 * - commitTransaction(tx) flushes batch then updates _computed.identifierLookup
 */

const {
    IDENTIFIERS_KEY,
    allocateNodeIdentifier,
    cloneIdentifierLookup,
    nodeIdToKeyFromLookup,
    nodeIdentifierToString,
    nodeKeyToIdFromLookup,
    serializeIdentifierLookup,
    stringToNodeIdentifier,
} = require('./database');
const { withComputedStateMutex } = require('./lock');

/** @typedef {import('./database/root_database').RootDatabase} RootDatabase */
/** @typedef {import('./database/root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./database/root_database').ValuesDatabase} ValuesDatabase */
/** @typedef {import('./database/root_database').FreshnessDatabase} FreshnessDatabase */
/** @typedef {import('./database/root_database').InputsDatabase} InputsDatabase */
/** @typedef {import('./database/root_database').RevdepsDatabase} RevdepsDatabase */
/** @typedef {import('./database/root_database').CountersDatabase} CountersDatabase */
/** @typedef {import('./database/root_database').TimestampsDatabase} TimestampsDatabase */
/** @typedef {import('./database/types').ComputedValue} ComputedValue */
/** @typedef {import('./database/types').Freshness} Freshness */
/** @typedef {import('./database/types').Counter} Counter */
/** @typedef {import('./database/types').TimestampRecord} TimestampRecord */
/** @typedef {import('./database/types').InputsRecord} InputsRecord */
/** @typedef {import('./database/types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./database/types').NodeKeyString} NodeKeyString */
/** @typedef {import('./database/identifier_lookup').IdentifierLookup} IdentifierLookup */
/** @typedef {import('../../sleeper').SleepCapability} SleepCapability */

/**
 * @template TValue
 * @typedef {object} BatchDatabaseOps
 * @property {(key: NodeIdentifier, value: TValue) => void} put - Queue a put operation in the current batch.
 * @property {(key: NodeIdentifier) => void} del - Queue a delete operation in the current batch.
 * @property {(key: NodeIdentifier) => Promise<TValue | undefined>} get - Read with read-your-writes batch consistency.
 */

/**
 * @typedef {object} BatchBuilder
 * @property {BatchDatabaseOps<ComputedValue>} values - Node value storage.
 * @property {BatchDatabaseOps<Freshness>} freshness - Freshness storage.
 * @property {BatchDatabaseOps<InputsRecord>} inputs - Dependency metadata storage.
 * @property {BatchDatabaseOps<NodeIdentifier[]>} revdeps - Reverse dependency index.
 * @property {BatchDatabaseOps<Counter>} counters - Change counters.
 * @property {BatchDatabaseOps<TimestampRecord>} timestamps - Creation/modification timestamps.
 */

/**
 * A Transaction groups all reads and writes for one top-level graph operation.
 * It contains:
 * - batch: LevelDB batch accumulator with read-your-writes overlay
 * - identifierLookup: working copy of the committed lookup, extended in-place
 *   with any new allocations made during this transaction
 *
 * @typedef {object} Transaction
 * @property {BatchBuilder} batch - LevelDB batch accumulator with read-your-writes.
 * @property {IdentifierLookup} identifierLookup - Working copy of the identifier lookup.
 */

/**
 * @typedef {object} GraphStorage
 * @property {ValuesDatabase} values - Identifier-keyed value storage.
 * @property {FreshnessDatabase} freshness - Identifier-keyed freshness storage.
 * @property {InputsDatabase} inputs - Identifier-keyed input metadata storage.
 * @property {RevdepsDatabase} revdeps - Identifier-keyed reverse dependency index.
 * @property {CountersDatabase} counters - Identifier-keyed counters.
 * @property {TimestampsDatabase} timestamps - Identifier-keyed timestamps.
 * @property {<T>(fn: (batch: BatchBuilder) => Promise<T>) => Promise<T>} withBatch - Run atomically against all graph sublevels (no identifier tracking).
 * @property {<T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>} withTransaction - Run atomically: creates transaction inside computed-state mutex, commits node writes and identifier map.
 * @property {(node: NodeIdentifier, inputs: NodeIdentifier[], inputCounters: number[], batch: BatchBuilder) => Promise<void>} ensureMaterialized - Persist the current inputs record for a node.
 * @property {(node: NodeIdentifier, inputs: NodeIdentifier[], batch: BatchBuilder) => Promise<void>} ensureReverseDepsIndexed - Add a node to each input's reverse-dependency list.
 * @property {(input: NodeIdentifier, batch: BatchBuilder) => Promise<NodeIdentifier[]>} listDependents - Read a node's dependents inside the current batch.
 * @property {(node: NodeIdentifier, batch: BatchBuilder) => Promise<NodeIdentifier[] | null>} getInputs - Read a node's inputs inside the current batch.
 * @property {() => Promise<NodeIdentifier[]>} listMaterializedNodes - List all materialized node identifiers.
 */

/**
 * Find the insertion point for an identifier inside an already-sorted identifier array.
 * @param {NodeIdentifier[]} sortedArray
 * @param {NodeIdentifier} nodeIdentifier
 * @returns {{ index: number, found: boolean }}
 */
function findInsertionIndex(sortedArray, nodeIdentifier) {
    const needle = nodeIdentifierToString(nodeIdentifier);
    let lo = 0;
    let hi = sortedArray.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const current = sortedArray[mid];
        if (current === undefined) {
            throw new Error(`findInsertionIndex: missing identifier at index ${String(mid)}`);
        }
        const currentString = nodeIdentifierToString(current);
        if (currentString === needle) {
            return { index: mid, found: true };
        }
        if (currentString < needle) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return { index: lo, found: false };
}

/**
 * Create a read-your-writes batch wrapper for a single typed sublevel.
 * Writes are queued as LevelDB batch operations (opaque objects); reads check the pending overlay
 * first and fall through to the underlying database on a miss.
 *
 * @template TValue
 * @param {{ get: (key: NodeIdentifier) => Promise<TValue | undefined>, putOp: (key: NodeIdentifier, value: TValue) => object, delOp: (key: NodeIdentifier) => object }} db
 * @param {Array<object>} operations - Shared operations array all sublevels append to.
 * @returns {BatchDatabaseOps<TValue>}
 */
function makeSublevelBatch(db, operations) {
    /** @type {Map<string, TValue>} */
    const puts = new Map();
    /** @type {Set<string>} */
    const dels = new Set();
    return {
        put(key, value) {
            const k = nodeIdentifierToString(key);
            puts.set(k, value);
            dels.delete(k);
            operations.push(db.putOp(key, value));
        },
        del(key) {
            const k = nodeIdentifierToString(key);
            dels.add(k);
            puts.delete(k);
            operations.push(db.delOp(key));
        },
        async get(key) {
            const k = nodeIdentifierToString(key);
            if (dels.has(k)) {
                return undefined;
            }
            const pending = puts.get(k);
            if (pending !== undefined) {
                return pending;
            }
            return await db.get(key);
        },
    };
}

/**
 * Create the batch builder and its shared operations array.
 * @param {SchemaStorage} schemaStorage
 * @returns {{ batch: BatchBuilder, operations: Array<*> }}
 */
function createBatch(schemaStorage) {
    /** @type {Array<*>} */
    const operations = [];
    /** @type {BatchBuilder} */
    const batch = {
        values: makeSublevelBatch(schemaStorage.values, operations),
        freshness: makeSublevelBatch(schemaStorage.freshness, operations),
        inputs: makeSublevelBatch(schemaStorage.inputs, operations),
        revdeps: makeSublevelBatch(schemaStorage.revdeps, operations),
        counters: makeSublevelBatch(schemaStorage.counters, operations),
        timestamps: makeSublevelBatch(schemaStorage.timestamps, operations),
    };
    return { batch, operations };
}

/**
 * Create the identifier-native graph storage facade for one schema namespace.
 * @param {RootDatabase} rootDatabase
 * @param {SleepCapability} sleeper
 * @returns {GraphStorage}
 */
function makeGraphStorage(rootDatabase, sleeper) {
    /**
     * @param {NodeIdentifier} node
     * @param {NodeIdentifier[]} inputs
     * @param {number[]} inputCounters
     * @param {BatchBuilder} batch
     * @returns {Promise<void>}
     */
    async function ensureMaterialized(node, inputs, inputCounters, batch) {
        if (inputs.length !== inputCounters.length) {
            throw new Error(
                `ensureMaterialized: inputs length (${inputs.length}) must match inputCounters length (${inputCounters.length}) for node ${nodeIdentifierToString(node)}`
            );
        }
        batch.inputs.put(node, {
            inputs: inputs.map(nodeIdentifierToString),
            inputCounters,
        });
    }

    /**
     * @param {NodeIdentifier} node
     * @param {NodeIdentifier[]} inputs
     * @param {BatchBuilder} batch
     * @returns {Promise<void>}
     */
    async function ensureReverseDepsIndexed(node, inputs, batch) {
        for (const input of inputs) {
            const existingDependents = await batch.revdeps.get(input);
            if (existingDependents === undefined) {
                batch.revdeps.put(input, [node]);
                continue;
            }
            const { index, found } = findInsertionIndex(existingDependents, node);
            if (found) {
                continue;
            }
            batch.revdeps.put(input, [
                ...existingDependents.slice(0, index),
                node,
                ...existingDependents.slice(index),
            ]);
        }
    }

    /**
     * @param {NodeIdentifier} input
     * @param {BatchBuilder} batch
     * @returns {Promise<NodeIdentifier[]>}
     */
    async function listDependents(input, batch) {
        return (await batch.revdeps.get(input)) ?? [];
    }

    /**
     * @param {NodeIdentifier} node
     * @param {BatchBuilder} batch
     * @returns {Promise<NodeIdentifier[] | null>}
     */
    async function getInputs(node, batch) {
        const record = await batch.inputs.get(node);
        if (record === undefined) {
            return null;
        }
        return record.inputs.map((input) => stringToNodeIdentifier(input));
    }

    /**
     * @returns {Promise<NodeIdentifier[]>}
     */
    async function listMaterializedNodes() {
        const nodes = [];
        for await (const key of rootDatabase.getSchemaStorage().inputs.keys()) {
            nodes.push(key);
        }
        return nodes;
    }

    return {
        get values() { return rootDatabase.getSchemaStorage().values; },
        get freshness() { return rootDatabase.getSchemaStorage().freshness; },
        get inputs() { return rootDatabase.getSchemaStorage().inputs; },
        get revdeps() { return rootDatabase.getSchemaStorage().revdeps; },
        get counters() { return rootDatabase.getSchemaStorage().counters; },
        get timestamps() { return rootDatabase.getSchemaStorage().timestamps; },
        async withBatch(fn) {
            const activeSchemaStorage = rootDatabase.getSchemaStorage();
            const { batch, operations } = createBatch(activeSchemaStorage);
            const result = await fn(batch);
            await activeSchemaStorage.batch(operations);
            return result;
        },
        /**
         * Run a batch that atomically commits node writes together with any new
         * identifier allocations made during the operation.
         *
         * This implements the transaction model from the volatile-consistency spec:
         * - createTransaction(): reads identifierLookup, creates fresh batch
         * - operation runs with the transaction
         * - commitTransaction(): flush batch to disk, then update identifierLookup
         *
         * The entire operation happens inside withComputedStateMutex, serializing all
         * concurrent callers end-to-end and eliminating identifier allocation races.
         *
         * Callers that are already inside the mutex (nested dependency pulls) must
         * NOT call this method again; they must receive the outer transaction via
         * explicit argument passing and operate on it directly.
         *
         * @template T
         * @param {(tx: Transaction) => Promise<T>} fn
         * @returns {Promise<T>}
         */
        async withTransaction(fn) {
            return await withComputedStateMutex(sleeper, rootDatabase.currentReplicaName(), async () => {
                // createTransaction(): reads _computed.identifierLookup, creates fresh batch.
                const activeSchemaStorage = rootDatabase.getSchemaStorage();
                const identifierLookup = rootDatabase.cloneActiveIdentifierLookup();
                const initialLookupSize = identifierLookup.keyToId.size;
                const { batch, operations } = createBatch(activeSchemaStorage);

                /** @type {Transaction} */
                const tx = { batch, identifierLookup };

                // Run the operation (identifier allocation + node-data writes).
                const value = await fn(tx);

                // commitTransaction(): disk-first — flush batch, then update volatile layer.
                const hasPendingAllocations = tx.identifierLookup.keyToId.size > initialLookupSize;
                if (hasPendingAllocations) {
                    const lookupToCommit = cloneIdentifierLookup(tx.identifierLookup);
                    if (activeSchemaStorage.global !== undefined) {
                        operations.push(
                            activeSchemaStorage.global.rawPutOp(
                                IDENTIFIERS_KEY,
                                serializeIdentifierLookup(lookupToCommit)
                            )
                        );
                    }
                    await activeSchemaStorage.batch(operations);
                    rootDatabase.replaceActiveIdentifierLookup(lookupToCommit);
                } else {
                    await activeSchemaStorage.batch(operations);
                }

                return value;
            });
        },
        ensureMaterialized,
        ensureReverseDepsIndexed,
        listDependents,
        getInputs,
        listMaterializedNodes,
    };
}

/**
 * Look up an existing identifier for a node key in the transaction's lookup.
 * Returns undefined if the node key is not in the lookup.
 * @param {Transaction} tx
 * @param {NodeKeyString} nodeKey
 * @returns {NodeIdentifier | undefined}
 */
function lookupNodeIdentifier(tx, nodeKey) {
    return nodeKeyToIdFromLookup(tx.identifierLookup, nodeKey);
}

/**
 * Look up an existing identifier or allocate a new one for a node key.
 * New allocations are added to the transaction's working lookup.
 * @param {Transaction} tx
 * @param {RootDatabase} rootDatabase
 * @param {NodeKeyString} nodeKey
 * @returns {NodeIdentifier}
 */
function getOrAllocateNodeIdentifier(tx, rootDatabase, nodeKey) {
    const existing = nodeKeyToIdFromLookup(tx.identifierLookup, nodeKey);
    if (existing !== undefined) {
        return existing;
    }
    return allocateNodeIdentifier(tx.identifierLookup, nodeKey, () =>
        rootDatabase.generateNodeIdentifier()
    );
}

/**
 * Convert an identifier back to its semantic node key.
 * Throws if the identifier is not in the transaction's lookup.
 * @param {Transaction} tx
 * @param {NodeIdentifier} nodeIdentifier
 * @returns {NodeKeyString}
 */
function requireNodeKey(tx, nodeIdentifier) {
    const nodeKey = nodeIdToKeyFromLookup(tx.identifierLookup, nodeIdentifier);
    if (nodeKey === undefined) {
        throw new Error(`Missing semantic node key for identifier ${nodeIdentifierToString(nodeIdentifier)}`);
    }
    return nodeKey;
}

module.exports = {
    makeGraphStorage,
    lookupNodeIdentifier,
    getOrAllocateNodeIdentifier,
    requireNodeKey,
};
