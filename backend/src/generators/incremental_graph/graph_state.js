/* eslint volodyslav/max-lines-per-file: "off" */
/**
 * Graph state management with transaction model for volatile-persistent consistency.
 *
 * Transactions execute user work without holding the commit mutex. They record
 * read-your-writes logical intents, reserve identifiers synchronously, and then
 * rebase/render those intents inside a short commit mutex.
 */

const {
    IDENTIFIERS_KEY,
    nodeIdentifierToString,
    stringToNodeIdentifier,
    makeTransactionIdentifierLookup,
    txNodeIdToKey,
    txNodeKeyToId,
    serializeIdentifierLookup,
    setIdentifierMapping,
} = require('./database');
const { withCommitMutex } = require('./lock');

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
/** @typedef {import('./database/identifier_lookup').TransactionIdentifierLookup} TransactionIdentifierLookup */
/** @typedef {import('../../sleeper').SleepCapability} SleepCapability */

let nextTransactionNumber = 1;

/**
 * @template TValue
 * @typedef {object} BatchDatabaseOps
 * @property {(key: NodeIdentifier, value: TValue) => void} put - Queue an absolute put intent.
 * @property {(key: NodeIdentifier) => void} del - Queue an absolute delete intent.
 * @property {(key: NodeIdentifier) => Promise<TValue | undefined>} get - Read with read-your-writes batch consistency.
 */

/**
 * @typedef {object} RevdepsBatchDatabaseOps
 * @property {(key: NodeIdentifier, value: NodeIdentifier[]) => void} put - Queue an absolute reverse-dependency put intent.
 * @property {(key: NodeIdentifier) => void} del - Queue an absolute reverse-dependency delete intent.
 * @property {(key: NodeIdentifier) => Promise<NodeIdentifier[] | undefined>} get - Read with read-your-writes and pending merge additions.
 * @property {(input: NodeIdentifier, dependent: NodeIdentifier) => void} addDependent - Queue a merge intent for one dependent.
 */

/**
 * @typedef {object} BatchBuilder
 * @property {BatchDatabaseOps<ComputedValue>} values - Node value storage.
 * @property {BatchDatabaseOps<Freshness>} freshness - Freshness storage.
 * @property {BatchDatabaseOps<InputsRecord>} inputs - Dependency metadata storage.
 * @property {RevdepsBatchDatabaseOps} revdeps - Reverse dependency index.
 * @property {BatchDatabaseOps<Counter>} counters - Change counters.
 * @property {BatchDatabaseOps<TimestampRecord>} timestamps - Creation/modification timestamps.
 */

/**
 * A Transaction groups all reads and writes for one top-level graph operation.
 *
 * @typedef {object} Transaction
 * @property {string} id - Diagnostic transaction identifier.
 * @property {BatchBuilder} batch - Logical intent accumulator with read-your-writes.
 * @property {TransactionIdentifierLookup} identifierLookup - Overlay identifier lookup.
 * @property {Set<string>} reservedIdentifiers - Identifier strings reserved by this transaction.
 * @property {Map<import('./types').NodeKeyString, Promise<import('./types').RecomputeResult>>} inFlight - Per-key in-flight pull promises.
 * @property {Set<string>} heldPullNodeLocks - Pull-node lock keys held until commit or abort.
 * @property {Array<() => void>} releasePullNodeLocks - Release callbacks for held pull-node locks.
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
 * @property {<T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>} withTransaction - Run a transaction, then commit its intents under the commit mutex.
 * @property {(node: NodeIdentifier, inputs: NodeIdentifier[], inputCounters: number[], batch: BatchBuilder) => Promise<void>} ensureMaterialized - Persist the current inputs record for a node.
 * @property {(node: NodeIdentifier, inputs: NodeIdentifier[], batch: BatchBuilder) => Promise<void>} ensureReverseDepsIndexed - Add a node to each input's reverse-dependency list.
 * @property {(input: NodeIdentifier, batch: BatchBuilder) => Promise<NodeIdentifier[]>} listDependents - Read a node's dependents inside the current batch.
 * @property {(node: NodeIdentifier, batch: BatchBuilder) => Promise<NodeIdentifier[] | null>} getInputs - Read a node's inputs inside the current batch.
 * @property {() => Promise<NodeIdentifier[]>} listMaterializedNodes - List all materialized node identifiers.
 */

/**
 * @typedef {object} LogicalBatchState
 * @property {Map<string, ComputedValue>} valuesPuts
 * @property {Set<string>} valuesDels
 * @property {Map<string, Freshness>} freshnessPuts
 * @property {Set<string>} freshnessDels
 * @property {Map<string, InputsRecord>} inputsPuts
 * @property {Set<string>} inputsDels
 * @property {Map<string, NodeIdentifier[]>} revdepsPuts
 * @property {Set<string>} revdepsDels
 * @property {Map<string, Set<string>>} revdepsAdds
 * @property {Map<string, Counter>} countersPuts
 * @property {Set<string>} countersDels
 * @property {Map<string, TimestampRecord>} timestampsPuts
 * @property {Set<string>} timestampsDels
 */

/**
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
 * @returns {LogicalBatchState}
 */
function makeLogicalBatchState() {
    return {
        valuesPuts: new Map(),
        valuesDels: new Set(),
        freshnessPuts: new Map(),
        freshnessDels: new Set(),
        inputsPuts: new Map(),
        inputsDels: new Set(),
        revdepsPuts: new Map(),
        revdepsDels: new Set(),
        revdepsAdds: new Map(),
        countersPuts: new Map(),
        countersDels: new Set(),
        timestampsPuts: new Map(),
        timestampsDels: new Set(),
    };
}

/**
 * @template TValue
 * @param {{ get: (key: NodeIdentifier) => Promise<TValue | undefined> }} db
 * @param {Map<string, TValue>} puts
 * @param {Set<string>} dels
 * @returns {BatchDatabaseOps<TValue>}
 */
function makeSublevelBatch(db, puts, dels) {
    return {
        put(key, value) {
            const keyString = nodeIdentifierToString(key);
            puts.set(keyString, value);
            dels.delete(keyString);
        },
        del(key) {
            const keyString = nodeIdentifierToString(key);
            dels.add(keyString);
            puts.delete(keyString);
        },
        async get(key) {
            const keyString = nodeIdentifierToString(key);
            if (dels.has(keyString)) {
                return undefined;
            }
            const pending = puts.get(keyString);
            if (pending !== undefined) {
                return pending;
            }
            return await db.get(key);
        },
    };
}

/**
 * @param {RevdepsDatabase} db
 * @param {LogicalBatchState} state
 * @returns {RevdepsBatchDatabaseOps}
 */
function makeRevdepsBatch(db, state) {
    return {
        put(key, value) {
            const keyString = nodeIdentifierToString(key);
            state.revdepsPuts.set(keyString, value);
            state.revdepsDels.delete(keyString);
        },
        del(key) {
            const keyString = nodeIdentifierToString(key);
            state.revdepsDels.add(keyString);
            state.revdepsPuts.delete(keyString);
            state.revdepsAdds.delete(keyString);
        },
        async get(key) {
            const keyString = nodeIdentifierToString(key);
            if (state.revdepsDels.has(keyString)) {
                return undefined;
            }
            let current = state.revdepsPuts.get(keyString);
            if (current === undefined) {
                current = await db.get(key);
            }
            const additions = state.revdepsAdds.get(keyString);
            if (additions === undefined || additions.size === 0) {
                return current;
            }
            let merged = current === undefined ? [] : current;
            for (const additionString of additions) {
                const addition = stringToNodeIdentifier(additionString);
                const { index, found } = findInsertionIndex(merged, addition);
                if (!found) {
                    merged = [
                        ...merged.slice(0, index),
                        addition,
                        ...merged.slice(index),
                    ];
                }
            }
            return merged;
        },
        addDependent(input, dependent) {
            const inputString = nodeIdentifierToString(input);
            let additions = state.revdepsAdds.get(inputString);
            if (additions === undefined) {
                additions = new Set();
                state.revdepsAdds.set(inputString, additions);
            }
            additions.add(nodeIdentifierToString(dependent));
        },
    };
}

/**
 * Create the batch builder and its logical intent state.
 * @param {SchemaStorage} schemaStorage
 * @returns {{ batch: BatchBuilder, state: LogicalBatchState }}
 */
function createBatch(schemaStorage) {
    const state = makeLogicalBatchState();
    const batch = {
        values: makeSublevelBatch(schemaStorage.values, state.valuesPuts, state.valuesDels),
        freshness: makeSublevelBatch(schemaStorage.freshness, state.freshnessPuts, state.freshnessDels),
        inputs: makeSublevelBatch(schemaStorage.inputs, state.inputsPuts, state.inputsDels),
        revdeps: makeRevdepsBatch(schemaStorage.revdeps, state),
        counters: makeSublevelBatch(schemaStorage.counters, state.countersPuts, state.countersDels),
        timestamps: makeSublevelBatch(schemaStorage.timestamps, state.timestampsPuts, state.timestampsDels),
    };
    return { batch, state };
}

/**
 * @param {Transaction} tx
 * @param {NodeIdentifier} identifier
 * @returns {NodeIdentifier}
 */
function canonicalizeIdentifier(tx, identifier) {
    const identifierString = nodeIdentifierToString(identifier);
    const nodeKey = tx.identifierLookup.idToKey.get(identifierString);
    if (nodeKey === undefined) {
        return identifier;
    }
    return txNodeKeyToId(tx.identifierLookup, nodeKey) ?? identifier;
}

/**
 * @param {Transaction} tx
 * @param {InputsRecord} record
 * @returns {InputsRecord}
 */
function canonicalizeInputsRecord(tx, record) {
    return {
        inputs: record.inputs.map((input) =>
            nodeIdentifierToString(canonicalizeIdentifier(tx, stringToNodeIdentifier(input)))
        ),
        inputCounters: record.inputCounters,
    };
}

/**
 * @template TValue
 * @param {Array<*>} operations
 * @param {{ putOp: (key: NodeIdentifier, value: TValue) => object, delOp: (key: NodeIdentifier) => object }} db
 * @param {Map<string, TValue>} puts
 * @param {Set<string>} dels
 * @param {(tx: Transaction, value: TValue) => TValue} canonicalizeValue
 * @param {Transaction} tx
 * @returns {void}
 */
function appendAbsoluteOperations(operations, db, puts, dels, canonicalizeValue, tx) {
    for (const keyString of dels) {
        operations.push(db.delOp(canonicalizeIdentifier(tx, stringToNodeIdentifier(keyString))));
    }
    for (const [keyString, value] of puts) {
        operations.push(db.putOp(
            canonicalizeIdentifier(tx, stringToNodeIdentifier(keyString)),
            canonicalizeValue(tx, value)
        ));
    }
}

/**
 * @param {Transaction} tx
 * @param {LogicalBatchState} state
 * @param {SchemaStorage} schemaStorage
 * @returns {Promise<Array<*>>}
 */
async function renderOperations(tx, state, schemaStorage) {
    /** @type {Array<*>} */
    const operations = [];
    appendAbsoluteOperations(operations, schemaStorage.values, state.valuesPuts, state.valuesDels, (_tx, value) => value, tx);
    appendAbsoluteOperations(operations, schemaStorage.freshness, state.freshnessPuts, state.freshnessDels, (_tx, value) => value, tx);
    appendAbsoluteOperations(operations, schemaStorage.inputs, state.inputsPuts, state.inputsDels, canonicalizeInputsRecord, tx);
    appendAbsoluteOperations(operations, schemaStorage.counters, state.countersPuts, state.countersDels, (_tx, value) => value, tx);
    appendAbsoluteOperations(operations, schemaStorage.timestamps, state.timestampsPuts, state.timestampsDels, (_tx, value) => value, tx);

    for (const keyString of state.revdepsDels) {
        operations.push(schemaStorage.revdeps.delOp(canonicalizeIdentifier(tx, stringToNodeIdentifier(keyString))));
    }
    for (const [keyString, value] of state.revdepsPuts) {
        operations.push(schemaStorage.revdeps.putOp(
            canonicalizeIdentifier(tx, stringToNodeIdentifier(keyString)),
            value.map((dependent) => canonicalizeIdentifier(tx, dependent))
        ));
    }
    for (const [inputString, dependentStrings] of state.revdepsAdds) {
        const input = canonicalizeIdentifier(tx, stringToNodeIdentifier(inputString));
        let merged = await schemaStorage.revdeps.get(input) ?? [];
        for (const dependentString of dependentStrings) {
            const dependent = canonicalizeIdentifier(tx, stringToNodeIdentifier(dependentString));
            const { index, found } = findInsertionIndex(merged, dependent);
            if (!found) {
                merged = [
                    ...merged.slice(0, index),
                    dependent,
                    ...merged.slice(index),
                ];
            }
        }
        operations.push(schemaStorage.revdeps.putOp(input, merged));
    }
    return operations;
}

/**
 * @param {RootDatabase} rootDatabase
 * @param {Transaction} tx
 * @returns {{ identifiersChanged: boolean, mergedLookup: import('./database/identifier_lookup').IdentifierLookup }}
 */
function rebaseIdentifierLookup(rootDatabase, tx) {
    let identifiersChanged = false;
    const committedLookup = rootDatabase.getActiveIdentifierLookup();
    const mergedLookup = rootDatabase.cloneActiveIdentifierLookup();
    for (const [reservedIdentifierString, nodeKey] of tx.identifierLookup.idToKey) {
        const committedIdentifier = committedLookup.keyToId.get(String(nodeKey));
        if (committedIdentifier !== undefined) {
            tx.identifierLookup.keyToId.set(String(nodeKey), committedIdentifier);
            continue;
        }
        if (!tx.reservedIdentifiers.has(reservedIdentifierString)) {
            continue;
        }
        if (typeof rootDatabase.hasInFlightIdentifier === "function" &&
            !rootDatabase.hasInFlightIdentifier(reservedIdentifierString)) {
            throw new Error(`Identifier reservation ${reservedIdentifierString} for transaction ${tx.id} is not in flight`);
        }
        setIdentifierMapping(
            mergedLookup,
            stringToNodeIdentifier(reservedIdentifierString),
            nodeKey
        );
        identifiersChanged = true;
    }
    return { identifiersChanged, mergedLookup };
}


/**
 * @param {RootDatabase} rootDatabase
 * @param {Set<string>} reservations
 * @returns {void}
 */
function clearRootIdentifierReservations(rootDatabase, reservations) {
    if (typeof rootDatabase.clearIdentifierReservations === "function") {
        rootDatabase.clearIdentifierReservations(reservations);
        return;
    }
    reservations.clear();
}

/**
 * @param {Transaction} tx
 * @returns {void}
 */
function releasePullNodeLocks(tx) {
    while (tx.releasePullNodeLocks.length > 0) {
        const release = tx.releasePullNodeLocks.pop();
        if (release !== undefined) {
            release();
        }
    }
    tx.heldPullNodeLocks.clear();
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
            batch.revdeps.addDependent(input, node);
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
            const { batch, state } = createBatch(activeSchemaStorage);
            const result = await fn(batch);
            const baseLookup = typeof rootDatabase.getActiveIdentifierLookup === "function"
                ? rootDatabase.getActiveIdentifierLookup()
                : { keyToId: new Map(), idToKey: new Map() };
            const txLookup = makeTransactionIdentifierLookup(baseLookup);
            const tx = {
                id: `batch-${String(nextTransactionNumber++)}`,
                batch,
                identifierLookup: txLookup,
                reservedIdentifiers: new Set(),
                inFlight: new Map(),
                heldPullNodeLocks: new Set(),
                releasePullNodeLocks: [],
            };
            const operations = await renderOperations(tx, state, activeSchemaStorage);
            await activeSchemaStorage.batch(operations);
            return result;
        },
        /**
         * Run a transaction without serializing its body. Identifier reservations
         * are synchronous and transaction intents are rebased under a short commit
         * mutex before the durable batch is flushed and volatile lookup published.
         *
         * @template T
         * @param {(tx: Transaction) => Promise<T>} fn
         * @returns {Promise<T>}
         */
        async withTransaction(fn) {
            const activeSchemaStorage = rootDatabase.getSchemaStorage();
            const baseLookup = typeof rootDatabase.getActiveIdentifierLookup === "function"
                ? rootDatabase.getActiveIdentifierLookup()
                : { keyToId: new Map(), idToKey: new Map() };
            const txLookup = makeTransactionIdentifierLookup(baseLookup);
            const { batch, state } = createBatch(activeSchemaStorage);
            const tx = {
                id: `tx-${String(nextTransactionNumber++)}`,
                batch,
                identifierLookup: txLookup,
                reservedIdentifiers: new Set(),
                inFlight: new Map(),
                heldPullNodeLocks: new Set(),
                releasePullNodeLocks: [],
            };
            try {
                const value = await fn(tx);
                return await withCommitMutex(sleeper, rootDatabase.currentReplicaName(), async () => {
                    const schemaStorage = rootDatabase.getSchemaStorage();
                    const { identifiersChanged, mergedLookup } = rebaseIdentifierLookup(rootDatabase, tx);
                    const operations = await renderOperations(tx, state, schemaStorage);
                    if (identifiersChanged) {
                        if (schemaStorage.global === undefined) {
                            throw new Error(
                                "Cannot commit identifier allocations: active schema storage has no global sublevel."
                            );
                        }
                        operations.push(schemaStorage.global.rawPutOp(
                            IDENTIFIERS_KEY,
                            serializeIdentifierLookup(mergedLookup)
                        ));
                    }
                    if (operations.length > 0) {
                        await schemaStorage.batch(operations);
                    }
                    if (identifiersChanged) {
                        rootDatabase.replaceActiveIdentifierLookup(mergedLookup);
                    }
                    clearRootIdentifierReservations(rootDatabase, tx.reservedIdentifiers);
                    releasePullNodeLocks(tx);
                    return value;
                });
            } catch (err) {
                clearRootIdentifierReservations(rootDatabase, tx.reservedIdentifiers);
                releasePullNodeLocks(tx);
                throw err;
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
 * @param {Transaction} tx
 * @param {NodeKeyString} nodeKey
 * @returns {NodeIdentifier | undefined}
 */
function lookupNodeIdentifier(tx, nodeKey) {
    return txNodeKeyToId(tx.identifierLookup, nodeKey);
}

/**
 * Look up an existing identifier or synchronously reserve a new one for a node key.
 * @param {Transaction} tx
 * @param {RootDatabase} rootDatabase
 * @param {NodeKeyString} nodeKey
 * @returns {NodeIdentifier}
 */
function getOrAllocateNodeIdentifier(tx, rootDatabase, nodeKey) {
    if (typeof rootDatabase.reserveNodeIdentifier === "function") {
        return rootDatabase.reserveNodeIdentifier(
            tx.identifierLookup,
            nodeKey,
            tx.reservedIdentifiers,
            tx.id
        );
    }
    const { txAllocateNodeIdentifier } = require('./database');
    return txAllocateNodeIdentifier(
        tx.identifierLookup,
        nodeKey,
        () => rootDatabase.generateNodeIdentifier()
    );
}

/**
 * Convert an identifier back to its semantic node key.
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
