/**
 * Graph state management with transaction model for volatile-persistent consistency.
 *
 * This module implements the transaction model specified in:
 * docs/specs/incremental-graph-volatile-consistency.md
 *
 * Key concepts:
 * - `_computed` is the injection of the durable database into memory (replica-
 *   derived runtime state). It holds `schemaStorage`, `identifierLookup`, etc.
 * - `_pendingAllocations` is ephemeral in-process state that lives outside
 *   `_computed` so it survives replica cutover. See root_database.js.
 * - A Transaction groups: batch (LevelDB batch accumulator with read-your-writes)
 *   + identifierLookup (working copy)
 * - createTransaction() reads _computed.identifierLookup and creates a fresh batch
 * - commitTransaction(tx) flushes batch then updates _computed.identifierLookup
 *
 * Transaction is minimal — only batch and identifierLookup.
 * Each pull call creates its own Transaction; validity writes and reserved
 * identifiers are managed by the caller (pullNode, invalidate), not by the
 * Transaction itself.
 */

const {
    IDENTIFIERS_KEY,
    LAST_NODE_INDEX_KEY,
    compareNodeIdentifier,
    nodeIdentifierFromString,
    nodeIdentifierToString,
    makeTransactionIdentifierLookup,
    txAllocateNodeIdentifier,
    txNodeIdToKey,
    txNodeKeyToId,
    serializeTransactionLookup,
    commitTransactionLookup,
} = require('./database');
const {
    darkroomActivity,
} = require('./lock');

/** @typedef {import('./database/root_database').RootDatabase} RootDatabase */
/** @typedef {import('./database/root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./database/root_database').ValuesDatabase} ValuesDatabase */
/** @typedef {import('./database/root_database').FreshnessDatabase} FreshnessDatabase */
/** @typedef {import('./database/root_database').InputsDatabase} InputsDatabase */
/** @typedef {import('./database/root_database').ValidDatabase} ValidDatabase */
/** @typedef {import('./database/root_database').CountersDatabase} CountersDatabase */
/** @typedef {import('./database/root_database').TimestampsDatabase} TimestampsDatabase */
/** @typedef {import('./database/types').ComputedValue} ComputedValue */
/** @typedef {import('./database/types').Freshness} Freshness */
/** @typedef {import('./database/types').Counter} Counter */
/** @typedef {import('./database/types').TimestampRecord} TimestampRecord */
/** @typedef {import('./database/types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./database/types').NodeKeyString} NodeKeyString */
/** @typedef {import('./database/identifier_lookup').TransactionIdentifierLookup} TransactionIdentifierLookup */
/** @typedef {import('../../sleeper').SleepCapability} SleepCapability */

/**
 * A validity mutation recorded by a graph transaction.
 * Mutations are resolved against the latest committed state at commit time
 * to prevent lost updates when concurrent transactions modify validity sets.
 *
 * @typedef {object} ValidMutation
 * @property {"add" | "remove"} kind
 * @property {NodeIdentifier} dependent
 *
 * @typedef {object} ValidClearMutation
 * @property {"clear"} kind
 */

/**
 * Apply recorded validity mutations to the latest committed state and push
 * the resulting put/del operations into the shared operations array.
 * Used by both withTransaction() and withBatch().
 *
 * @param {SchemaStorage} activeSchemaStorage
 * @param {Array<*>} operations
 * @param {Map<string, Array<ValidMutation | ValidClearMutation>>} validMutations
 * @returns {Promise<void>}
 */
async function appendValidMutationOps(activeSchemaStorage, operations, validMutations) {
    if (validMutations.size === 0) {
        return;
    }
    for (const [depIdStr, mutations] of validMutations.entries()) {
        const depId = nodeIdentifierFromString(depIdStr);
        let validSet = await activeSchemaStorage.valid.get(depId) ?? [];
        for (const m of mutations) {
            if (m.kind === "clear") {
                validSet = [];
            } else if (m.kind === "add") {
                const depStr = nodeIdentifierToString(m.dependent);
                if (!validSet.some(id => nodeIdentifierToString(id) === depStr)) {
                    validSet.push(m.dependent);
                }
            } else if (m.kind === "remove") {
                const depStr = nodeIdentifierToString(m.dependent);
                validSet = validSet.filter(id => nodeIdentifierToString(id) !== depStr);
            }
        }
        validSet.sort(compareNodeIdentifier);
        if (validSet.length === 0) {
            operations.push(activeSchemaStorage.valid.delOp(depId));
        } else {
            operations.push(activeSchemaStorage.valid.putOp(depId, validSet));
        }
    }
}

/**
 * @template TValue
 * @typedef {object} BatchDatabaseOps
 * @property {(key: NodeIdentifier, value: TValue) => void} put - Queue a put operation in the current batch.
 * @property {(key: NodeIdentifier) => void} del - Queue a delete operation in the current batch.
 * @property {(key: NodeIdentifier) => Promise<TValue | undefined>} get - Read with read-your-writes batch consistency.
 */

/**
 * @typedef {object} ValidBatchOps
 * @property {(depId: NodeIdentifier, dependentId: NodeIdentifier) => void} add - Record an add-dependency mutation.
 * @property {(depId: NodeIdentifier, dependentId: NodeIdentifier) => void} remove - Record a remove-dependency mutation.
 * @property {(depId: NodeIdentifier) => void} clear - Record a clear mutation.
 * @property {(depId: NodeIdentifier) => Promise<NodeIdentifier[]>} get - Read database value merged with pending transaction-local mutations.
 * @property {(depId: NodeIdentifier, value: NodeIdentifier[]) => void} put - Convenience: clear followed by add for each element.
 * @property {(depId: NodeIdentifier) => void} del - Convenience: same as clear.
 */

/**
 * @typedef {object} BatchBuilder
 * @property {BatchDatabaseOps<ComputedValue>} values - Node value storage.
 * @property {BatchDatabaseOps<Freshness>} freshness - Freshness storage.
 * @property {BatchDatabaseOps<NodeIdentifier[]>} inputs - Dependency metadata storage.
 * @property {ValidBatchOps} valid - Validity flags with mutation tracking for concurrent safety.
 * @property {BatchDatabaseOps<Counter>} counters - Change counters.
 * @property {BatchDatabaseOps<TimestampRecord>} timestamps - Creation/modification timestamps.
 */

/**
 * A Transaction groups reads and writes for one graph operation.
 * It is deliberately minimal — each pull call creates its own Transaction.
 * Reserved identifiers and other per-pull state are managed
 * by the caller (pullNode / invalidate), not by the Transaction.
 *
 * - batch: LevelDB batch accumulator with read-your-writes overlay.
 * - identifierLookup: a `TransactionIdentifierLookup` overlay backed by a
 *   read-only reference to the committed `_computed.identifierLookup`.
 *   At commit time the overlay is applied to the base in-place after a
 *   successful disk flush (disk-first invariant).
 *
 * @typedef {object} Transaction
 * @property {BatchBuilder} batch - LevelDB batch accumulator with read-your-writes.
 * @property {TransactionIdentifierLookup} identifierLookup - Overlay-based identifier lookup.
 */

/**
 * @typedef {object} GraphStorage
 * @property {ValuesDatabase} values - Identifier-keyed value storage.
 * @property {FreshnessDatabase} freshness - Identifier-keyed freshness storage.
 * @property {InputsDatabase} inputs - Identifier-keyed input metadata storage.
 * @property {ValidDatabase} valid - Identifier-keyed inverse validity flags.
 * @property {CountersDatabase} counters - Identifier-keyed counters.
 * @property {TimestampsDatabase} timestamps - Identifier-keyed timestamps.
 * @property {<T>(fn: (batch: BatchBuilder) => Promise<T>) => Promise<T>} withBatch - Run atomically against all graph sublevels (no identifier tracking).
 * @property {<T>(fn: (tx: Transaction) => Promise<{value: T}>) => Promise<T>} withTransaction - Run atomically with read-your-writes batching and commit publication.
 * @property {(node: NodeIdentifier, inputs: NodeIdentifier[], batch: BatchBuilder) => Promise<void>} ensureMaterialized - Persist the current input edges for a node.
 * @property {(node: NodeIdentifier, batch: BatchBuilder) => Promise<NodeIdentifier[] | null>} getInputs - Read a node's inputs inside the current batch.
 * @property {(node: NodeIdentifier, batch: BatchBuilder) => Promise<NodeIdentifier[]>} getValid - Read a node's valid set inside the current batch.
 * @property {() => Promise<NodeIdentifier[]>} listMaterializedNodes - List all materialized node identifiers.
 * @property {<T>(procedure: () => Promise<T>) => Promise<T>} withCommitSnapshot - Run a read while darkroom publication is paused.
 */

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
                // Note: the whole database has this invariant that `undefined` is not permitted as a value,
                // so seeing `pending === undefined` guarantees `puts.has(k) === false`.
                return pending;
            }
            return await db.get(key);
        },
    };
}

/**
 * Create transaction-local validity batch operations that record mutations
 * instead of doing read-modify-write on whole arrays.  Mutations are resolved
 * against the latest committed state under the darkroom lock at commit time
 * to prevent lost updates from concurrent graph transactions.
 *
 * @param {{ get: (key: NodeIdentifier) => Promise<NodeIdentifier[] | undefined>, putOp: (key: NodeIdentifier, value: NodeIdentifier[]) => object, delOp: (key: NodeIdentifier) => object }} db
 * @param {Map<string, Array<ValidMutation | ValidClearMutation>>} validMutations
 * @returns {ValidBatchOps}
 */
function makeValidBatchOps(db, validMutations) {
    return {
        add(depId, dependentId) {
            const k = nodeIdentifierToString(depId);
            let muts = validMutations.get(k);
            if (!muts) {
                muts = [];
                validMutations.set(k, muts);
            }
            muts.push({ kind: "add", dependent: dependentId });
        },
        remove(depId, dependentId) {
            const k = nodeIdentifierToString(depId);
            let muts = validMutations.get(k);
            if (!muts) {
                muts = [];
                validMutations.set(k, muts);
            }
            muts.push({ kind: "remove", dependent: dependentId });
        },
        clear(depId) {
            const k = nodeIdentifierToString(depId);
            validMutations.set(k, [{ kind: "clear" }]);
        },
        async get(depId) {
            const k = nodeIdentifierToString(depId);
            const muts = validMutations.get(k);
            let result = await db.get(depId) ?? [];
            if (muts) {
                for (const m of muts) {
                    if (m.kind === "clear") {
                        result = [];
                    } else if (m.kind === "add") {
                        const depStr = nodeIdentifierToString(m.dependent);
                        if (!result.some(id => nodeIdentifierToString(id) === depStr)) {
                            result.push(m.dependent);
                        }
                    } else if (m.kind === "remove") {
                        const depStr = nodeIdentifierToString(m.dependent);
                        result = result.filter(id => nodeIdentifierToString(id) !== depStr);
                    }
                }
                result.sort(compareNodeIdentifier);
            }
            return result;
        },
        put(depId, value) {
            this.clear(depId);
            for (const dep of value) {
                this.add(depId, dep);
            }
        },
        del(depId) {
            this.clear(depId);
        },
    };
}

/**
 * Create the batch builder, its shared operations array, and a validity
 * mutation log.  The mutation log allows concurrent graph transactions to
 * record add/remove/clear operations that are merged at commit time instead
 * of doing read-modify-write on whole `valid[D]` arrays outside the
 * serialised commit section.
 *
 * @param {SchemaStorage} schemaStorage
 * @returns {{ batch: BatchBuilder, operations: Array<*>, validMutations: Map<string, Array<ValidMutation | ValidClearMutation>> }}
 */
function createBatch(schemaStorage) {
    /** @type {Array<*>} */
    const operations = [];
    /** @type {Map<string, Array<ValidMutation | ValidClearMutation>>} */
    const validMutations = new Map();
    /** @type {BatchBuilder} */
    const batch = {
        values: makeSublevelBatch(schemaStorage.values, operations),
        freshness: makeSublevelBatch(schemaStorage.freshness, operations),
        inputs: makeSublevelBatch(schemaStorage.inputs, operations),
        valid: makeValidBatchOps(schemaStorage.valid, validMutations),
        counters: makeSublevelBatch(schemaStorage.counters, operations),
        timestamps: makeSublevelBatch(schemaStorage.timestamps, operations),
    };
    return { batch, operations, validMutations };
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
     * @param {BatchBuilder} batch
     * @returns {Promise<void>}
     */
    async function ensureMaterialized(node, inputs, batch) {
        batch.inputs.put(node, inputs);
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
        return record;
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
        get valid() { return rootDatabase.getSchemaStorage().valid; },
        get counters() { return rootDatabase.getSchemaStorage().counters; },
        get timestamps() { return rootDatabase.getSchemaStorage().timestamps; },
        async withBatch(fn) {
            const activeSchemaStorage = rootDatabase.getSchemaStorage();
            const { batch, operations, validMutations } = createBatch(activeSchemaStorage);
            const result = await fn(batch);

            await darkroomActivity(sleeper, rootDatabase.currentReplicaName(), async () => {
                await appendValidMutationOps(activeSchemaStorage, operations, validMutations);
                if (operations.length > 0) {
                    await activeSchemaStorage.batch(operations);
                }
            });

            return result;
        },
        /**
         * Run a batch that atomically commits node writes together with any new
         * identifier allocations made during the operation.
         *
         * This implements the transaction model from the volatile-consistency spec:
         * - Creates an overlay-based TransactionIdentifierLookup backed by a direct
         *   (non-cloned) reference to the committed lookup, then creates a fresh
         *   batch accumulator. No full-copy clone is performed.
          * - The operation callback runs WITHOUT the darkroom lock.
          * - The callback returns the value published by the transaction.
         * - At commit time batch is flushed to disk, then the identifier overlay is
         *   applied to the base in-place (disk-first ordering).
         *
         * Reserved identifiers are managed by the caller (e.g. pullNode).
         *
          * **Stale-reference note:** `getSchemaStorage()` and
          * `getActiveIdentifierLookup()` are called at entry to re-acquire fresh
          * references from `_computed`, which is the injection of the durable
          * database into memory (every field is reconstructible from disk).
          * Do NOT capture these references across `await` in calling code unless
          * protected by the appropriate dome activity lock — a concurrent replica
          * cutover (`setCurrentReplicaPointer`) replaces `_computed` and would
          * leave your captured references pointing at the old replica.
         *
         * ## Locking preconditions
         *
         * The caller MUST already hold the dome activity lock in one of the
         * following modes.  `withTransaction` does not acquire the dome lock
         * itself — it relies on the caller for stale-reference safety.
         *
         *   | Caller              | Must hold                |
         *   |---------------------|--------------------------|
         *   | pullNode (pull.js)  | dome nighttime + telescope(node) |
         *   | internalUnsafeInvalidate (invalidate.js) | dome daytime |
         *   | makeSemanticStorage (test helper) | none (test-only; single-threaded) |
         *
         * The dome lock prevents `setCurrentReplicaPointer` (which needs
         * dome holiday) from running concurrently, so the `activeSchemaStorage`
         * and `txLookup` references captured at entry remain valid across all
         * awaits inside the transaction body.  The commit finalisation
         * acquires the per-replica darkroom lock internally.
         *
         * @template T
         * @param {(tx: Transaction) => Promise<{value: T}>} fn
         * @returns {Promise<T>}
         */
        async withTransaction(fn) {
            const activeSchemaStorage = rootDatabase.getSchemaStorage();
            const txLookup = makeTransactionIdentifierLookup(rootDatabase.getActiveIdentifierLookup());
            const { batch, operations, validMutations } = createBatch(activeSchemaStorage);

            /** @type {Transaction} */
            const tx = { batch, identifierLookup: txLookup };

            try {
                const result = await fn(tx);
                const value = result.value;

                await darkroomActivity(sleeper, rootDatabase.currentReplicaName(), async () => {
                    await appendValidMutationOps(activeSchemaStorage, operations, validMutations);

                    const hasPendingOperations = operations.length > 0;
                    const hasPendingAllocations = tx.identifierLookup.keyToId.size > 0;

                    if (!hasPendingOperations && !hasPendingAllocations) {
                        return;
                    }

                    if (hasPendingAllocations) {
                        const commitLastNodeIndex = rootDatabase.getCurrentAllocationWatermark();
                        operations.push(
                            activeSchemaStorage.global.putOp(
                                IDENTIFIERS_KEY,
                                serializeTransactionLookup(tx.identifierLookup)
                            )
                        );
                        operations.push(
                            activeSchemaStorage.global.putOp(
                                LAST_NODE_INDEX_KEY,
                                commitLastNodeIndex
                            )
                        );

                        await activeSchemaStorage.batch(operations);

                        commitTransactionLookup(tx.identifierLookup);
                        rootDatabase.advanceLastNodeIndex(commitLastNodeIndex);
                    } else {
                        await activeSchemaStorage.batch(operations);
                    }
                });

                return value;
            } finally {
                // Release identifier reservations owned by this transaction.
                // After a successful commit the identifiers are in the base
                // lookup; after a failure they must be released so the map
                // does not leak.
                rootDatabase.releaseIdentifierReservations(txLookup.ownedKeys);
            }
        },
        ensureMaterialized,
        getInputs,
        /**
         * @param {NodeIdentifier} node
         * @param {BatchBuilder} batch
         * @returns {Promise<NodeIdentifier[]>}
         */
        async getValid(node, batch) {
            return (await batch.valid.get(node)) ?? [];
        },
        listMaterializedNodes,
        withCommitSnapshot(procedure) {
            return darkroomActivity(sleeper, rootDatabase.currentReplicaName(), procedure);
        },
    };
}

/**
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
 *
 * Allocation is delegated to `rootDatabase._allocateKeyIdentifier` which
 * claims a key→identifier mapping in `_pendingAllocations`.
 *
 * @param {Transaction} tx
 * @param {RootDatabase} rootDatabase
 * @param {NodeKeyString} nodeKey
 * @returns {NodeIdentifier}
 */
function getOrAllocateNodeIdentifier(tx, rootDatabase, nodeKey) {
    const existing = lookupNodeIdentifier(tx, nodeKey);
    if (existing !== undefined) {
        return existing;
    }
    return txAllocateNodeIdentifier(
        tx.identifierLookup,
        nodeKey,
        () => rootDatabase.generateNodeIdentifier(),
        rootDatabase,
    );
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
