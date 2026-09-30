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
 *   `_computed` so it survives replica cutover. It is multi-owner: a live
 *   operation which needs a key another live operation already reserved joins
 *   that reservation and shares its identifier. See root_database.js.
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
    nodeIdentifierToString,
    makeTransactionIdentifierLookup,
    txAllocateNodeIdentifier,
    txNodeIdToKey,
    txNodeKeyToId,
    serializeTransactionLookup,
    commitTransactionLookup,
    ReplicaStateInvariantError,
} = require('./database');
const {
    darkroomActivity,
} = require('./lock');
const {
    appendJournalPublicationOps,
    readCommittedWriterState,
} = require('./journal_store');
const { finalizeEmission, makeJournalPublicationError } = require('./journal');
const { makeTransactionJournal } = require('./journal_staging');
const { appendValidMutationOps, applyValidMutations } = require('./validity_mutations');

/** @typedef {import('./database/root_database').RootDatabase} RootDatabase */
/** @typedef {import('./database/root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./database/root_database').ValuesDatabase} ValuesDatabase */
/** @typedef {import('./database/root_database').FreshnessDatabase} FreshnessDatabase */
/** @typedef {import('./database/root_database').ValidDatabase} ValidDatabase */
/** @typedef {import('./database/root_database').TimestampsDatabase} TimestampsDatabase */
/** @typedef {import('./database/root_database').JournalDatabase} JournalDatabase */
/** @typedef {import('./database/types').ComputedValue} ComputedValue */
/** @typedef {import('./database/types').Freshness} Freshness */
/** @typedef {import('./database/types').TimestampRecord} TimestampRecord */
/** @typedef {import('./database/types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./database/types').NodeKeyString} NodeKeyString */
/** @typedef {import('./database/node_key').NodeKey} NodeKey */
/** @typedef {import('./database/identifier_lookup').TransactionIdentifierLookup} TransactionIdentifierLookup */
/** @typedef {import('./journal/emission').EmissionIntent} EmissionIntent */
/** @typedef {import('./journal/emission').MaterializeInput} MaterializeInput */
/** @typedef {import('./journal/types').JournalRecordId} JournalRecordId */
/** @typedef {import('../../sleeper').SleepCapability} SleepCapability */
/** @typedef {import('../../datetime').Datetime} Datetime */

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
 * @property {ValidBatchOps} valid - Validity flags with mutation tracking for concurrent safety.
 * @property {BatchDatabaseOps<TimestampRecord>} timestamps - Creation/modification timestamps.
 */

/**
 * The Journal's half of one graph transaction: the semantic intents the settled
 * transition staged, and the value occurrences those intents validate against.
 *
 * Staging is what makes a publication's records members of the same atomic write as
 * the graph mutations they describe. Nothing here writes: `stage` only records an
 * intent, and the commit seam turns the staged intents into Journal operations of
 * the batch it is already about to issue.
 *
 * @typedef {object} TransactionJournal
 * @property {(intent: EmissionIntent) => void} stage - Record one settled semantic intent of the transition.
 * @property {(node: NodeKey) => Promise<MaterializeInput>} inputOccurrence - The occurrence a certificate of a node names for one of its current direct inputs.
 * @property {(node: NodeKey) => Promise<JournalRecordId>} requireCommittedOccurrence - The committed occurrence of a node, which a value-scoped record of this transition must name.
 * @property {() => ReadonlyArray<EmissionIntent>} staged - The intents recorded so far, in no particular order.
 */

/**
 * A Transaction groups reads and writes for one user-visible graph operation.
 * It is deliberately minimal — one user operation owns exactly one Transaction.
 * Reserved identifiers and other per-operation state are managed
 * by the caller (pullNode / invalidate), not by the Transaction.
 *
 * - batch: LevelDB batch accumulator with read-your-writes overlay.
 * - identifierLookup: a `TransactionIdentifierLookup` overlay backed by a
 *   read-only reference to the committed `_computed.identifierLookup`.
 *   At commit time the overlay is applied to the base in-place after a
 *   successful disk flush (disk-first invariant).
 * - journal: the semantic intents whose Journal records the same commit publishes.
 *
 * @typedef {object} Transaction
 * @property {BatchBuilder} batch - LevelDB batch accumulator with read-your-writes.
 * @property {TransactionIdentifierLookup} identifierLookup - Overlay-based identifier lookup.
 * @property {TransactionJournal} journal - The staged Journal half of the transaction.
 */

/**
 * One user-visible graph operation, together with the single Transaction whose
 * commit publishes both the graph mutations and their Journal records.
 *
 * The properties that this class carries are:
 * - Every graph write the operation performs is an operation of `transaction`'s
 *   batch, and every semantic effect of those writes is a staged intent of
 *   `transaction`'s journal, so one commit publishes both sides together.
 *
 * The proof of those properties is guaranteed by:
 * - This class can only be introduced through these functions:
 *   - `withUserOperation(fn)`: satisfies the property because it creates the one
 *     transaction the operation uses, hands that transaction to `fn`, and commits
 *     it exactly once when `fn` returns.
 *   - `withTransaction(fn)`: satisfies the property because it is `withUserOperation`
 *     with the transaction's own value as the operation's value.
 *
 * @typedef {object} UserOperation
 * @property {Transaction} transaction - The one transaction the operation publishes through.
 */

/**
 * @typedef {object} GraphStorage
 * @property {ValuesDatabase} values - Identifier-keyed value storage.
 * @property {FreshnessDatabase} freshness - Identifier-keyed freshness storage.
 * @property {ValidDatabase} valid - Identifier-keyed inverse validity flags.
 * @property {TimestampsDatabase} timestamps - Identifier-keyed timestamps.
 * @property {<T>(fn: (batch: BatchBuilder) => Promise<T>) => Promise<T>} withBatch - Run atomically against all graph sublevels (no identifier tracking).
 * @property {<T>(fn: (tx: Transaction) => Promise<{value: T}>) => Promise<T>} withTransaction - Run atomically with read-your-writes batching and commit publication.
 * @property {<T>(fn: (operation: UserOperation) => Promise<T>) => Promise<T>} withUserOperation - Run one user-visible operation whose whole graph transition and Journal publication commit as one atomic write.
 * @property {(node: NodeIdentifier, batch: BatchBuilder) => Promise<NodeIdentifier[]>} getValid - Read a node's valid set inside the current batch.
 * @property {() => Promise<NodeIdentifier[]>} listMaterializedNodes - List materialized node identifiers from value storage.
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
 * A clear withdraws every committed dependent of the set it clears, so
 * `put` and `del` record a clear and then the `add` for each element they mean
 * to establish.
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
            validMutations.set(nodeIdentifierToString(depId), [{ kind: "clear" }]);
        },
        async get(depId) {
            const k = nodeIdentifierToString(depId);
            return applyValidMutations(await db.get(depId) ?? [], validMutations.get(k) ?? []);
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
        valid: makeValidBatchOps(schemaStorage.valid, validMutations),
        timestamps: makeSublevelBatch(schemaStorage.timestamps, operations),
    };
    return { batch, operations, validMutations };
}

/**
 * Create the identifier-native graph storage facade for one schema namespace.
 * @param {RootDatabase} rootDatabase
 * @param {SleepCapability} sleeper
 * @param {Datetime} datetime
 * @returns {GraphStorage}
 */
function makeGraphStorage(rootDatabase, sleeper, datetime) {
    /**
     * @returns {Promise<NodeIdentifier[]>}
     */
    async function listMaterializedNodes() {
        const lookup = rootDatabase.getActiveIdentifierLookup();
        const nodes = [];
        for await (const identifier of rootDatabase.getSchemaStorage().values.keys()) {
            const identifierString = nodeIdentifierToString(identifier);
            if (!lookup.idToKey.has(identifierString)) {
                throw new ReplicaStateInvariantError(
                    "materialized-node listing",
                    "has cached value but no identifier lookup entry",
                    identifierString
                );
            }
            nodes.push(identifier);
        }
        return nodes.sort(compareNodeIdentifier);
    }

    return {
        get values() { return rootDatabase.getSchemaStorage().values; },
        get freshness() { return rootDatabase.getSchemaStorage().freshness; },
        get valid() { return rootDatabase.getSchemaStorage().valid; },
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
         * A user operation is the unit of atomic publication: one transaction, one
         * batch, and therefore one atomic write carrying the graph mutations, the
         * identifier table, the allocation watermark, the Journal records and the
         * Journal committed-pair metadata together. A graph transition which staged no
         * Journal intent is refused rather than published without the records that
         * describe it.
         *
         * @template T
         * @param {(operation: UserOperation) => Promise<T>} fn
         * @returns {Promise<T>}
         */
        async withUserOperation(fn) {
            const activeSchemaStorage = rootDatabase.getSchemaStorage();
            const txLookup = makeTransactionIdentifierLookup(rootDatabase.getActiveIdentifierLookup());
            const { batch, operations, validMutations } = createBatch(activeSchemaStorage);
            const journal = makeTransactionJournal(activeSchemaStorage.journal);

            /** @type {Transaction} */
            const tx = { batch, identifierLookup: txLookup, journal };

            try {
                /** @type {UserOperation} */
                const operation = { transaction: tx };
                const value = await fn(operation);

                await darkroomActivity(sleeper, rootDatabase.currentReplicaName(), async () => {
                    await appendValidMutationOps(activeSchemaStorage, operations, validMutations);

                    const hasPendingOperations = operations.length > 0;
                    const hasPendingAllocations = tx.identifierLookup.keyToId.size > 0;
                    const stagedIntents = journal.staged();

                    if (!hasPendingOperations && !hasPendingAllocations && stagedIntents.length === 0) {
                        return;
                    }

                    if (hasPendingOperations && stagedIntents.length === 0) {
                        throw makeJournalPublicationError(
                            "the graph transition wrote " + operations.length +
                                " operation(s) but staged no journal intent, so it would be " +
                                "durable without the journal records that describe it"
                        );
                    }

                    /** @type {number | undefined} */
                    let commitLastNodeIndex;
                    if (hasPendingAllocations) {
                        commitLastNodeIndex = rootDatabase.getCurrentAllocationWatermark();
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
                    }

                    if (stagedIntents.length > 0) {
                        const committed = await readCommittedWriterState(
                            activeSchemaStorage.journal,
                            rootDatabase.getFingerprint()
                        );
                        if (committed instanceof Error) {
                            throw committed;
                        }
                        const publication = finalizeEmission({
                            state: committed,
                            intents: stagedIntents,
                            publicationInstant: datetime.now().toMillis(),
                            allocatorWatermark: commitLastNodeIndex ?? committed.allocatorWatermark,
                        });
                        if (publication instanceof Error) {
                            throw publication;
                        }
                        const rejected = appendJournalPublicationOps(
                            activeSchemaStorage.journal,
                            operations,
                            publication
                        );
                        if (rejected !== undefined) {
                            throw rejected;
                        }
                    }

                    await activeSchemaStorage.batch(operations);

                    if (hasPendingAllocations && commitLastNodeIndex !== undefined) {
                        commitTransactionLookup(tx.identifierLookup);
                        rootDatabase.advanceLastNodeIndex(commitLastNodeIndex);
                    }
                });

                return value;
            } finally {
                // Give up this operation's hold on every identifier reservation it
                // took, whether it minted the identifier or joined another live
                // operation's reservation for the same key. After a successful
                // commit the identifiers are in the base lookup; after a failure
                // the holds must be given up so the map does not leak. A reservation
                // whose last holder gives it up here disappears, and one which
                // another operation still holds survives for that operation.
                rootDatabase.releaseIdentifierReservations(txLookup.ownedKeys);
            }
        },
        /**
         * One user operation whose whole transition is one transaction.
         * @template T
         * @param {(tx: Transaction) => Promise<{value: T}>} fn
         * @returns {Promise<T>}
         */
        async withTransaction(fn) {
            return this.withUserOperation(async (operation) => {
                const result = await fn(operation.transaction);
                return result.value;
            });
        },
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
 * Look up an existing identifier or reserve one for a node key.
 * New reservations are recorded only in the transaction's overlay, not in the
 * committed base lookup. They become part of the base only after a successful
 * disk flush via `commitTransactionLookup`.
 *
 * Reservation is delegated to `rootDatabase._allocateKeyIdentifier`, which
 * claims a key→identifier mapping in `_pendingAllocations` or joins a live one
 * another operation already holds for the same key.
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
