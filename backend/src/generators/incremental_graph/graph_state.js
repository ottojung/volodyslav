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
    nodeIdentifierToString,
    stringToNodeIdentifier,
    makeTransactionIdentifierLookup,
    txNodeIdToKey,
    txNodeKeyToId,
    serializeTransactionLookup,
    commitTransactionLookup,
} = require('./database');
const { withComputedStateMutex } = require('./lock');

/**
 * @typedef {import('./database/root_database').RootDatabase & {
 *     getIdentifierReservationState?: () => { inFlightIdentifiers: Set<string>, inFlightIdentifierOwners: Map<string, string> },
 *     __graphReservationState?: { inFlightIdentifiers: Set<string>, inFlightIdentifierOwners: Map<string, string> },
 * }} RootDatabase
 */
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
/** @typedef {import('./database/identifier_lookup').TransactionIdentifierLookup} TransactionIdentifierLookup */
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
 * - identifierLookup: a `TransactionIdentifierLookup` that holds only the
 *   **new** allocations made during this transaction in a small overlay map,
 *   backed by a read-only reference to the committed `_computed.identifierLookup`.
 *   Lookups check the overlay first and fall through to the base.
 *   At commit time, the overlay is applied to the base in-place after a
 *   successful disk flush (disk-first invariant).
 *
 * @typedef {object} Transaction
 * @property {string} id - Diagnostic transaction identifier.
 * @property {BatchBuilder} batch - LevelDB batch accumulator with read-your-writes.
 * @property {TransactionIdentifierLookup} identifierLookup - Overlay-based identifier lookup.
 * @property {Set<string>} reservedIdentifiers - Identifier strings reserved by this live transaction.
 * @property {Map<import('./types').NodeKeyString, Promise<import('./types').RecomputeResult>>} inFlight - Per-key in-flight pull promises for deduplication of concurrent nested pulls.
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
 * @property {<T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>} withTransaction - Run a transaction body concurrently and serialize only commit/publish.
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

let nextTransactionCounter = 0;

/**
 * @returns {string}
 */
function makeTransactionId() {
    nextTransactionCounter += 1;
    return `tx-${String(nextTransactionCounter)}`;
}

/**
 * Ensure the active root computed state contains live identifier-reservation
 * diagnostics used by concurrent transactions.
 * @param {RootDatabase} rootDatabase
 * @returns {{ inFlightIdentifiers: Set<string>, inFlightIdentifierOwners: Map<string, string> }}
 */
function ensureIdentifierReservationState(rootDatabase) {
    if (rootDatabase.getIdentifierReservationState !== undefined) {
        return rootDatabase.getIdentifierReservationState();
    }
    if (rootDatabase.__graphReservationState === undefined) {
        rootDatabase.__graphReservationState = {
            inFlightIdentifiers: new Set(),
            inFlightIdentifierOwners: new Map(),
        };
    }
    return rootDatabase.__graphReservationState;
}

/**
 * Clear this transaction's live identifier reservations from the active root
 * computed state. The volatile committed lookup is intentionally untouched.
 * @param {Transaction} tx
 * @param {RootDatabase} rootDatabase
 * @returns {void}
 */
function clearIdentifierReservations(tx, rootDatabase) {
    const { inFlightIdentifiers, inFlightIdentifierOwners } =
        ensureIdentifierReservationState(rootDatabase);
    for (const identifierString of tx.reservedIdentifiers) {
        inFlightIdentifiers.delete(identifierString);
        const owner = inFlightIdentifierOwners.get(identifierString);
        if (owner === tx.id) {
            inFlightIdentifierOwners.delete(identifierString);
        }
    }
    tx.reservedIdentifiers.clear();
}

/**
 * Synchronously reserve a fresh node identifier for a transaction overlay.
 * The check/generate/reserve/update-overlay sequence never awaits and never
 * calls user code, so it is atomic within one Node.js event loop.
 * @param {Transaction} tx
 * @param {RootDatabase} rootDatabase
 * @param {NodeKeyString} nodeKey
 * @param {number} [maxAttempts=64]
 * @returns {NodeIdentifier}
 */
function reserveNodeIdentifier(tx, rootDatabase, nodeKey, maxAttempts = 64) {
    const existing = txNodeKeyToId(tx.identifierLookup, nodeKey);
    if (existing !== undefined) {
        return existing;
    }

    const { inFlightIdentifiers, inFlightIdentifierOwners } =
        ensureIdentifierReservationState(rootDatabase);
    const keyString = String(nodeKey);
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const candidate = rootDatabase.generateNodeIdentifier();
        const candidateString = nodeIdentifierToString(candidate);
        if (txNodeIdToKey(tx.identifierLookup, candidate) !== undefined) {
            continue;
        }
        if (inFlightIdentifiers.has(candidateString)) {
            continue;
        }

        inFlightIdentifiers.add(candidateString);
        inFlightIdentifierOwners.set(candidateString, tx.id);
        tx.identifierLookup.keyToId.set(keyString, candidate);
        tx.identifierLookup.idToKey.set(candidateString, nodeKey);
        tx.reservedIdentifiers.add(candidateString);
        return candidate;
    }

    throw new Error(`Failed to reserve a unique node identifier for ${keyString}`);
}

/**
 * Create the identifier-native graph storage facade for one schema namespace.
 * @param {RootDatabase} rootDatabase
 * @param {SleepCapability} [sleeper]
 * @returns {GraphStorage}
 */
function makeGraphStorage(rootDatabase, sleeper) {
    /**
     * @template T
     * @param {() => Promise<T>} procedure
     * @returns {Promise<T>}
     */
    const withCommitMutex = async (procedure) => {
        if (sleeper === undefined) {
            return await procedure();
        }
        return await withComputedStateMutex(
            sleeper,
            rootDatabase.currentReplicaName(),
            procedure
        );
    };
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
         * Run a transaction body concurrently and serialize only the commit.
         *
         * Identifier allocation uses synchronous live reservations during the
         * transaction body. Node writes are queued in a private read-your-writes
         * batch. The commit mutex covers only durable batch flush, volatile
         * identifier publication, and reservation cleanup, preserving disk-first
         * volatile consistency without serializing computor execution.
         *
         * @template T
         * @param {(tx: Transaction) => Promise<T>} fn
         * @returns {Promise<T>}
         */
        async withTransaction(fn) {
            const activeSchemaStorage = rootDatabase.getSchemaStorage();
            const txLookup = makeTransactionIdentifierLookup(rootDatabase.getActiveIdentifierLookup());
            const { batch, operations } = createBatch(activeSchemaStorage);

            /** @type {Transaction} */
            const tx = {
                id: makeTransactionId(),
                batch,
                identifierLookup: txLookup,
                reservedIdentifiers: new Set(),
                inFlight: new Map(),
            };

            try {
                const value = await fn(tx);

                return await withCommitMutex(async () => {
                    const hasPendingOperations = operations.length > 0;
                    const hasPendingAllocations = tx.identifierLookup.keyToId.size > 0;
                    const hasPersistentDelta = hasPendingOperations || hasPendingAllocations;

                    if (!hasPersistentDelta) {
                        clearIdentifierReservations(tx, rootDatabase);
                        return value;
                    }

                    if (hasPendingAllocations) {
                        if (activeSchemaStorage.global === undefined) {
                            throw new Error(
                                "Cannot commit identifier allocations: activeSchemaStorage.global is undefined. " +
                                "The volatile state cannot be synchronized with disk, which would violate " +
                                "the disk-first ordering invariant (volatile must not advance ahead of disk)."
                            );
                        }
                        operations.push(
                            activeSchemaStorage.global.rawPutOp(
                                IDENTIFIERS_KEY,
                                serializeTransactionLookup(tx.identifierLookup)
                            )
                        );
                    }

                    await activeSchemaStorage.batch(operations);

                    if (hasPendingAllocations) {
                        commitTransactionLookup(tx.identifierLookup);
                    }
                    clearIdentifierReservations(tx, rootDatabase);

                    return value;
                });
            } catch (error) {
                clearIdentifierReservations(tx, rootDatabase);
                throw error;
            }
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
 * Checks the overlay first, then falls through to the committed base.
 * Returns undefined if the node key is not found in either.
 * @param {Transaction} tx
 * @param {NodeKeyString} nodeKey
 * @returns {NodeIdentifier | undefined}
 */
function lookupNodeIdentifier(tx, nodeKey) {
    return txNodeKeyToId(tx.identifierLookup, nodeKey);
}

/**
 * Look up an existing identifier or allocate a new one for a node key.
 * New allocations are recorded only in the transaction's overlay, not in the
 * committed base lookup. They become part of the base only after a successful
 * disk flush via `commitTransactionLookup`.
 * @param {Transaction} tx
 * @param {RootDatabase} rootDatabase
 * @param {NodeKeyString} nodeKey
 * @returns {NodeIdentifier}
 */
function getOrAllocateNodeIdentifier(tx, rootDatabase, nodeKey) {
    return reserveNodeIdentifier(tx, rootDatabase, nodeKey);
}

/**
 * Convert an identifier back to its semantic node key.
 * Checks the overlay first, then falls through to the committed base.
 * Throws if the identifier is not found in either.
 * @param {Transaction} tx
 * @param {NodeIdentifier} nodeIdentifier
 * @returns {NodeKeyString}
 */
function requireNodeKey(tx, nodeIdentifier) {
    const nodeKey = txNodeIdToKey(tx.identifierLookup, nodeIdentifier);
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
