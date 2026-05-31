/* eslint volodyslav/max-lines-per-file: "off" */
/**
 * Graph state management with transaction model for volatile-persistent consistency.
 *
 * Transactions collect logical node-state writes and identifier reservations while
 * computors run.  Only the short commit phase is serialized: it rebases the
 * transaction onto the latest committed identifier lookup, renders writes, flushes
 * one durable batch, publishes the volatile lookup, and clears reservations.
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
/** @typedef {import('./database/identifier_lookup').TransactionIdentifierLookup} TransactionIdentifierLookup */
/** @typedef {import('../../sleeper').SleepCapability} SleepCapability */

/** @typedef {'values' | 'freshness' | 'inputs' | 'revdeps' | 'counters' | 'timestamps'} GraphSublevelName */

/**
 * @typedef {object} LogicalPutOperation
 * @property {'put'} type
 * @property {GraphSublevelName} sublevelName
 * @property {NodeIdentifier} key
 * @property {*} value
 */

/**
 * @typedef {object} LogicalDelOperation
 * @property {'del'} type
 * @property {GraphSublevelName} sublevelName
 * @property {NodeIdentifier} key
 */

/** @typedef {LogicalPutOperation | LogicalDelOperation} LogicalOperation */

/**
 * @template TValue
 * @typedef {object} BatchDatabaseOps
 * @property {(key: NodeIdentifier, value: TValue) => void} put
 * @property {(key: NodeIdentifier) => void} del
 * @property {(key: NodeIdentifier) => Promise<TValue | undefined>} get
 */

/**
 * @typedef {object} BatchBuilder
 * @property {BatchDatabaseOps<ComputedValue>} values
 * @property {BatchDatabaseOps<Freshness>} freshness
 * @property {BatchDatabaseOps<InputsRecord>} inputs
 * @property {BatchDatabaseOps<NodeIdentifier[]>} revdeps
 * @property {BatchDatabaseOps<Counter>} counters
 * @property {BatchDatabaseOps<TimestampRecord>} timestamps
 * @property {(input: NodeIdentifier, dependent: NodeIdentifier) => void} addRevdep
 * @property {Map<string, Set<string>>} revdepsAdds
 */

/**
 * @typedef {object} Transaction
 * @property {string} id
 * @property {BatchBuilder} batch
 * @property {TransactionIdentifierLookup} identifierLookup
 * @property {Set<string>} reservedIdentifiers
 * @property {Map<import('./types').NodeKeyString, Promise<import('./types').RecomputeResult>>} inFlight
 * @property {Set<string>} heldPullNodeLocks
 * @property {Map<string, () => void>} pullNodeLockReleases
 */

/**
 * @typedef {object} GraphStorage
 * @property {ValuesDatabase} values
 * @property {FreshnessDatabase} freshness
 * @property {InputsDatabase} inputs
 * @property {RevdepsDatabase} revdeps
 * @property {CountersDatabase} counters
 * @property {TimestampsDatabase} timestamps
 * @property {<T>(fn: (batch: BatchBuilder) => Promise<T>) => Promise<T>} withBatch
 * @property {<T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>} withTransaction
 * @property {(nodeKey: NodeKeyString, tx: Transaction) => Promise<void>} acquirePullNodeLock
 * @property {(node: NodeIdentifier, inputs: NodeIdentifier[], inputCounters: number[], batch: BatchBuilder) => Promise<void>} ensureMaterialized
 * @property {(node: NodeIdentifier, inputs: NodeIdentifier[], batch: BatchBuilder) => Promise<void>} ensureReverseDepsIndexed
 * @property {(input: NodeIdentifier, batch: BatchBuilder) => Promise<NodeIdentifier[]>} listDependents
 * @property {(node: NodeIdentifier, batch: BatchBuilder) => Promise<NodeIdentifier[] | null>} getInputs
 * @property {() => Promise<NodeIdentifier[]>} listMaterializedNodes
 */

let nextTransactionId = 1;

/**
 * @typedef {object} PullNodeLockState
 * @property {boolean} locked
 * @property {Array<() => void>} waiters
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
 * @template TValue
 * @param {{ get: (key: NodeIdentifier) => Promise<TValue | undefined> }} db
 * @param {Array<LogicalOperation>} operations
 * @param {GraphSublevelName} sublevelName
 * @returns {BatchDatabaseOps<TValue>}
 */
function makeSublevelBatch(db, operations, sublevelName) {
    /** @type {Map<string, TValue>} */
    const puts = new Map();
    /** @type {Set<string>} */
    const dels = new Set();
    return {
        put(key, value) {
            const k = nodeIdentifierToString(key);
            puts.set(k, value);
            dels.delete(k);
            operations.push({ type: 'put', sublevelName, key, value });
        },
        del(key) {
            const k = nodeIdentifierToString(key);
            dels.add(k);
            puts.delete(k);
            operations.push({ type: 'del', sublevelName, key });
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
 * @param {SchemaStorage} schemaStorage
 * @returns {{ batch: BatchBuilder, operations: Array<LogicalOperation> }}
 */
function createBatch(schemaStorage) {
    /** @type {Array<LogicalOperation>} */
    const operations = [];
    /** @type {Map<string, Set<string>>} */
    const revdepsAdds = new Map();
    /** @type {BatchBuilder} */
    const batch = {
        values: makeSublevelBatch(schemaStorage.values, operations, 'values'),
        freshness: makeSublevelBatch(schemaStorage.freshness, operations, 'freshness'),
        inputs: makeSublevelBatch(schemaStorage.inputs, operations, 'inputs'),
        revdeps: makeSublevelBatch(schemaStorage.revdeps, operations, 'revdeps'),
        counters: makeSublevelBatch(schemaStorage.counters, operations, 'counters'),
        timestamps: makeSublevelBatch(schemaStorage.timestamps, operations, 'timestamps'),
        revdepsAdds,
        addRevdep(input, dependent) {
            const inputString = nodeIdentifierToString(input);
            let dependents = revdepsAdds.get(inputString);
            if (dependents === undefined) {
                dependents = new Set();
                revdepsAdds.set(inputString, dependents);
            }
            dependents.add(nodeIdentifierToString(dependent));
        },
    };
    return { batch, operations };
}

/**
 * @param {SchemaStorage} schemaStorage
 * @param {GraphSublevelName} sublevelName
 * @returns {{ putOp: (key: NodeIdentifier, value: *) => object, delOp: (key: NodeIdentifier) => object }}
 */
function schemaSublevel(schemaStorage, sublevelName) {
    return schemaStorage[sublevelName];
}

/**
 * @param {NodeIdentifier} identifier
 * @param {Map<string, NodeIdentifier>} canonicalByReservedIdentifier
 * @returns {NodeIdentifier}
 */
function rewriteIdentifier(identifier, canonicalByReservedIdentifier) {
    return canonicalByReservedIdentifier.get(nodeIdentifierToString(identifier)) ?? identifier;
}

/**
 * @param {InputsRecord} record
 * @param {Map<string, NodeIdentifier>} canonicalByReservedIdentifier
 * @returns {InputsRecord}
 */
function rewriteInputsRecord(record, canonicalByReservedIdentifier) {
    return {
        inputs: record.inputs.map((input) =>
            nodeIdentifierToString(rewriteIdentifier(stringToNodeIdentifier(input), canonicalByReservedIdentifier))
        ),
        inputCounters: record.inputCounters,
    };
}

/**
 * @param {*} value
 * @param {GraphSublevelName} sublevelName
 * @param {Map<string, NodeIdentifier>} canonicalByReservedIdentifier
 * @returns {*}
 */
function rewriteValue(value, sublevelName, canonicalByReservedIdentifier) {
    if (sublevelName === 'inputs') {
        return rewriteInputsRecord(value, canonicalByReservedIdentifier);
    }
    if (sublevelName === 'revdeps') {
        /** @type {NodeIdentifier[]} */
        const identifiers = value;
        return identifiers.map((identifier) => rewriteIdentifier(identifier, canonicalByReservedIdentifier));
    }
    return value;
}

/**
 * @param {SchemaStorage} schemaStorage
 * @param {LogicalOperation} operation
 * @param {Map<string, NodeIdentifier>} canonicalByReservedIdentifier
 * @returns {object}
 */
function renderOperation(schemaStorage, operation, canonicalByReservedIdentifier) {
    const target = schemaSublevel(schemaStorage, operation.sublevelName);
    const key = rewriteIdentifier(operation.key, canonicalByReservedIdentifier);
    if (operation.type === 'del') {
        return target.delOp(key);
    }
    return target.putOp(
        key,
        rewriteValue(operation.value, operation.sublevelName, canonicalByReservedIdentifier)
    );
}

/**
 * @param {Map<string, Set<string>>} revdepsAdds
 * @param {Map<string, NodeIdentifier>} canonicalByReservedIdentifier
 * @returns {Map<string, Set<string>>}
 */
function rewriteRevdepsAdds(revdepsAdds, canonicalByReservedIdentifier) {
    /** @type {Map<string, Set<string>>} */
    const rewritten = new Map();
    for (const [inputString, dependents] of revdepsAdds) {
        const input = rewriteIdentifier(stringToNodeIdentifier(inputString), canonicalByReservedIdentifier);
        const rewrittenInputString = nodeIdentifierToString(input);
        let rewrittenDependents = rewritten.get(rewrittenInputString);
        if (rewrittenDependents === undefined) {
            rewrittenDependents = new Set();
            rewritten.set(rewrittenInputString, rewrittenDependents);
        }
        for (const dependentString of dependents) {
            const dependent = rewriteIdentifier(stringToNodeIdentifier(dependentString), canonicalByReservedIdentifier);
            rewrittenDependents.add(nodeIdentifierToString(dependent));
        }
    }
    return rewritten;
}

/**
 * @param {SchemaStorage} schemaStorage
 * @param {Map<string, Set<string>>} revdepsAdds
 * @returns {Promise<object[]>}
 */
async function renderRevdepsAdds(schemaStorage, revdepsAdds) {
    /** @type {object[]} */
    const operations = [];
    for (const [inputString, dependentStrings] of revdepsAdds) {
        const input = stringToNodeIdentifier(inputString);
        let current = (await schemaStorage.revdeps.get(input)) ?? [];
        for (const dependentString of dependentStrings) {
            const dependent = stringToNodeIdentifier(dependentString);
            const { index, found } = findInsertionIndex(current, dependent);
            if (!found) {
                current = [
                    ...current.slice(0, index),
                    dependent,
                    ...current.slice(index),
                ];
            }
        }
        operations.push(schemaStorage.revdeps.putOp(input, current));
    }
    return operations;
}

/**
 * @param {Map<string, PullNodeLockState>} pullNodeLocks
 * @param {NodeKeyString} nodeKey
 * @param {Transaction} tx
 * @returns {Promise<void>}
 */
async function acquirePullNodeLockFromTable(pullNodeLocks, nodeKey, tx) {
    const key = String(nodeKey);
    if (tx.heldPullNodeLocks.has(key)) {
        return;
    }
    let state = pullNodeLocks.get(key);
    if (state === undefined) {
        state = { locked: false, waiters: [] };
        pullNodeLocks.set(key, state);
    }
    while (state.locked) {
        await new Promise((resolve) => {
            state?.waiters.push(() => resolve(undefined));
        });
        state = pullNodeLocks.get(key);
        if (state === undefined) {
            state = { locked: false, waiters: [] };
            pullNodeLocks.set(key, state);
        }
    }
    state.locked = true;
    tx.heldPullNodeLocks.add(key);
    tx.pullNodeLockReleases.set(key, () => {
        const activeState = pullNodeLocks.get(key);
        if (activeState === undefined) {
            return;
        }
        const next = activeState.waiters.shift();
        if (next === undefined) {
            pullNodeLocks.delete(key);
            return;
        }
        activeState.locked = false;
        next();
    });
}

/**
 * @param {Transaction} tx
 * @returns {void}
 */
function releasePullNodeLocks(tx) {
    for (const release of tx.pullNodeLockReleases.values()) {
        release();
    }
    tx.pullNodeLockReleases.clear();
    tx.heldPullNodeLocks.clear();
}

/**
 * @typedef {object} RebasedIdentifiers
 * @property {Map<string, NodeIdentifier>} canonicalByReservedIdentifier
 * @property {Array<[NodeIdentifier, NodeKeyString]>} mappingsToPublish
 * @property {Array<[NodeIdentifier, NodeKeyString]> | null} serializedLookup
 */

/**
 * @param {RootDatabase} rootDatabase
 * @param {Transaction} tx
 * @returns {RebasedIdentifiers}
 */
function rebaseIdentifierOverlay(rootDatabase, tx) {
    const committedLookup = rootDatabase.getActiveIdentifierLookup();
    const mergedLookup = rootDatabase.cloneActiveIdentifierLookup();
    /** @type {Map<string, NodeIdentifier>} */
    const canonicalByReservedIdentifier = new Map();
    /** @type {Array<[NodeIdentifier, NodeKeyString]>} */
    const mappingsToPublish = [];
    for (const [keyString, reservedIdentifier] of tx.identifierLookup.keyToId) {
        const existingIdentifier = committedLookup.keyToId.get(keyString);
        const reservedString = nodeIdentifierToString(reservedIdentifier);
        if (existingIdentifier !== undefined) {
            canonicalByReservedIdentifier.set(reservedString, existingIdentifier);
            continue;
        }
        if (!tx.reservedIdentifiers.has(reservedString)) {
            throw new Error(`Transaction ${tx.id} lost reservation for identifier ${reservedString}`);
        }
        if (
            typeof rootDatabase.hasInFlightNodeIdentifier === 'function' &&
            !rootDatabase.hasInFlightNodeIdentifier(reservedString)
        ) {
            throw new Error(`Identifier ${reservedString} is not reserved by a live transaction`);
        }
        const committedKey = committedLookup.idToKey.get(reservedString);
        if (committedKey !== undefined && String(committedKey) !== keyString) {
            throw new Error(`Identifier ${reservedString} is already committed for a different node key`);
        }
        const overlayNodeKey = tx.identifierLookup.idToKey.get(reservedString);
        if (overlayNodeKey === undefined) {
            throw new Error(`Transaction ${tx.id} has no node key for reserved identifier ${reservedString}`);
        }
        setIdentifierMapping(mergedLookup, reservedIdentifier, overlayNodeKey);
        mappingsToPublish.push([reservedIdentifier, overlayNodeKey]);
        canonicalByReservedIdentifier.set(reservedString, reservedIdentifier);
    }
    return {
        canonicalByReservedIdentifier,
        mappingsToPublish,
        serializedLookup: mappingsToPublish.length > 0 ? serializeIdentifierLookup(mergedLookup) : null,
    };
}

/**
 * Create the identifier-native graph storage facade for one schema namespace.
 * @param {RootDatabase} rootDatabase
 * @param {SleepCapability} sleeper
 * @returns {GraphStorage}
 */
function makeGraphStorage(rootDatabase, sleeper) {
    /** @type {Map<string, PullNodeLockState>} */
    const pullNodeLocks = new Map();

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
            batch.addRevdep(input, node);
        }
    }

    /**
     * @param {NodeIdentifier} input
     * @param {BatchBuilder} batch
     * @returns {Promise<NodeIdentifier[]>}
     */
    async function listDependents(input, batch) {
        const existing = (await batch.revdeps.get(input)) ?? [];
        const additions = batch.revdepsAdds.get(nodeIdentifierToString(input));
        if (additions === undefined) {
            return existing;
        }
        let merged = existing;
        for (const dependentString of additions) {
            const dependent = stringToNodeIdentifier(dependentString);
            const { index, found } = findInsertionIndex(merged, dependent);
            if (!found) {
                merged = [
                    ...merged.slice(0, index),
                    dependent,
                    ...merged.slice(index),
                ];
            }
        }
        return merged;
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
            /** @type {Array<*>} */
            const renderedOperations = operations.map((operation) =>
                renderOperation(activeSchemaStorage, operation, new Map())
            );
            renderedOperations.push(...await renderRevdepsAdds(activeSchemaStorage, batch.revdepsAdds));
            await activeSchemaStorage.batch(renderedOperations);
            return result;
        },
        async withTransaction(fn) {
            const activeSchemaStorage = rootDatabase.getSchemaStorage();
            const txLookup = makeTransactionIdentifierLookup(rootDatabase.getActiveIdentifierLookup());
            const { batch, operations } = createBatch(activeSchemaStorage);
            /** @type {Transaction} */
            const tx = {
                id: `tx-${String(nextTransactionId++)}`,
                batch,
                identifierLookup: txLookup,
                reservedIdentifiers: new Set(),
                inFlight: new Map(),
                heldPullNodeLocks: new Set(),
                pullNodeLockReleases: new Map(),
            };

            try {
                const value = await fn(tx);
                await withComputedStateMutex(sleeper, rootDatabase.currentReplicaName(), async () => {
                    const commitSchemaStorage = rootDatabase.getSchemaStorage();
                    const { canonicalByReservedIdentifier, mappingsToPublish, serializedLookup } = rebaseIdentifierOverlay(rootDatabase, tx);
                    /** @type {Array<*>} */
                    const renderedOperations = operations.map((operation) =>
                        renderOperation(commitSchemaStorage, operation, canonicalByReservedIdentifier)
                    );
                    const rewrittenRevdepsAdds = rewriteRevdepsAdds(batch.revdepsAdds, canonicalByReservedIdentifier);
                    renderedOperations.push(...await renderRevdepsAdds(commitSchemaStorage, rewrittenRevdepsAdds));
                    if (serializedLookup !== null) {
                        renderedOperations.push(
                            commitSchemaStorage.global.rawPutOp(
                                IDENTIFIERS_KEY,
                                serializedLookup
                            )
                        );
                    }
                    if (renderedOperations.length > 0) {
                        await commitSchemaStorage.batch(renderedOperations);
                    }
                    for (const [identifier, nodeKey] of mappingsToPublish) {
                        setIdentifierMapping(rootDatabase.getActiveIdentifierLookup(), identifier, nodeKey);
                    }
                });
                return value;
            } finally {
                if (typeof rootDatabase.releaseNodeIdentifierReservations === 'function') {
                    rootDatabase.releaseNodeIdentifierReservations(tx.reservedIdentifiers);
                } else {
                    tx.reservedIdentifiers.clear();
                }
                releasePullNodeLocks(tx);
            }
        },
        acquirePullNodeLock(nodeKey, tx) {
            return acquirePullNodeLockFromTable(pullNodeLocks, nodeKey, tx);
        },
        ensureMaterialized,
        ensureReverseDepsIndexed,
        listDependents,
        getInputs,
        listMaterializedNodes,
    };
}

/**
 * @param {Transaction} tx
 * @param {NodeKeyString} nodeKey
 * @returns {NodeIdentifier | undefined}
 */
function lookupNodeIdentifier(tx, nodeKey) {
    return txNodeKeyToId(tx.identifierLookup, nodeKey);
}

/**
 * @param {Transaction} tx
 * @param {RootDatabase} rootDatabase
 * @param {NodeKeyString} nodeKey
 * @returns {NodeIdentifier}
 */
function getOrAllocateNodeIdentifier(tx, rootDatabase, nodeKey) {
    const existing = txNodeKeyToId(tx.identifierLookup, nodeKey);
    if (existing !== undefined) {
        return existing;
    }
    const keyString = String(nodeKey);
    if (tx.reservedIdentifiers === undefined) {
        tx.reservedIdentifiers = new Set();
    }
    if (tx.id === undefined) {
        tx.id = 'tx-legacy-test';
    }
    /**
     * @param {NodeIdentifier} candidate
     * @returns {void}
     */
    const reserveInTransaction = (candidate) => {
        tx.identifierLookup.keyToId.set(keyString, candidate);
        tx.identifierLookup.idToKey.set(nodeIdentifierToString(candidate), nodeKey);
    };
    if (typeof rootDatabase.reserveNodeIdentifier !== 'function') {
        const candidate = rootDatabase.generateNodeIdentifier();
        tx.reservedIdentifiers.add(nodeIdentifierToString(candidate));
        reserveInTransaction(candidate);
        return candidate;
    }
    return rootDatabase.reserveNodeIdentifier(
        tx.id,
        nodeKey,
        tx.reservedIdentifiers,
        (candidate) => txNodeIdToKey(tx.identifierLookup, candidate),
        reserveInTransaction
    );
}

/**
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
