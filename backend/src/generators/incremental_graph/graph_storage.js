/* eslint volodyslav/max-lines-per-file: "off" */
/**
 * Identifier-native graph storage.
 * This module is the low-level persistence layer below the semantic graph API.
 */

const {
    databaseKeyToNodeIdentifier,
    nodeIdentifierFromString,
    nodeIdentifierToDatabaseKey,
    nodeIdentifierToString,
} = require('./database');

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
/** @typedef {import('./database/node_identifier').NodeIdentifier} NodeIdentifier */

/**
 * @template TValue
 * @typedef {object} IdentifierDatabase
 * @property {(key: NodeIdentifier) => Promise<TValue | undefined>} get - Read one identifier-keyed record.
 * @property {(key: NodeIdentifier, value: TValue) => Promise<void>} put - Write one identifier-keyed record.
 * @property {(key: NodeIdentifier) => Promise<void>} del - Delete one identifier-keyed record.
 * @property {() => AsyncIterable<NodeIdentifier>} keys - Iterate over identifier keys in storage order.
 */

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
 * @typedef {<T>(fn: (batch: BatchBuilder) => Promise<T>) => Promise<T>} BatchFunction
 */

/**
 * @typedef {object} GraphStorage
 * @property {IdentifierDatabase<ComputedValue>} values - Identifier-keyed value storage.
 * @property {IdentifierDatabase<Freshness>} freshness - Identifier-keyed freshness storage.
 * @property {IdentifierDatabase<InputsRecord>} inputs - Identifier-keyed input metadata storage.
 * @property {IdentifierDatabase<NodeIdentifier[]>} revdeps - Identifier-keyed reverse dependency index.
 * @property {IdentifierDatabase<Counter>} counters - Identifier-keyed counters.
 * @property {IdentifierDatabase<TimestampRecord>} timestamps - Identifier-keyed timestamps.
 * @property {BatchFunction} withBatch - Run atomically against all graph sublevels.
 * @property {(node: NodeIdentifier, inputs: NodeIdentifier[], inputCounters: number[], batch: BatchBuilder) => Promise<void>} ensureMaterialized - Persist the current inputs record for a node.
 * @property {(node: NodeIdentifier, inputs: NodeIdentifier[], batch: BatchBuilder) => Promise<void>} ensureReverseDepsIndexed - Add a node to each input's reverse-dependency list.
 * @property {(input: NodeIdentifier, batch: BatchBuilder) => Promise<NodeIdentifier[]>} listDependents - Read a node's dependents inside the current batch.
 * @property {(node: NodeIdentifier, batch: BatchBuilder) => Promise<NodeIdentifier[] | null>} getInputs - Read a node's inputs inside the current batch.
 * @property {() => Promise<NodeIdentifier[]>} listMaterializedNodes - List all materialized node identifiers.
 */

/**
 * Convert a nominal identifier to the underlying database key used by typed sublevels.
 * @param {NodeIdentifier} nodeIdentifier
 * @returns {import('./database/types').NodeKeyString}
 */
function toDatabaseKey(nodeIdentifier) {
    return nodeIdentifierToDatabaseKey(nodeIdentifier);
}

/**
 * Create a stable string key for per-batch overlay maps.
 * @param {NodeIdentifier} nodeIdentifier
 * @returns {string}
 */
function pendingKey(nodeIdentifier) {
    return nodeIdentifierToString(nodeIdentifier);
}

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
 * Read a value from the per-batch overlay.
 * @template TValue
 * @param {Map<string, TValue>} pendingPuts
 * @param {Set<string>} pendingDels
 * @param {NodeIdentifier} key
 * @returns {TValue | undefined}
 */
function readPendingValue(pendingPuts, pendingDels, key) {
    const overlayKey = pendingKey(key);
    if (pendingDels.has(overlayKey)) {
        return undefined;
    }
    return pendingPuts.get(overlayKey);
}

/**
 * Create the identifier-native batch builder used by the low-level storage API.
 * @param {SchemaStorage} schemaStorage
 * @returns {BatchFunction}
 */
function makeBatchBuilder(schemaStorage) {
    /** @type {BatchFunction} */
    const withBatch = async (fn) => {
        /** @type {Array<*>} */
        const operations = [];

        /** @type {Map<string, ComputedValue>} */
        const valuesPuts = new Map();
        /** @type {Set<string>} */
        const valuesDels = new Set();
        /** @type {Map<string, Freshness>} */
        const freshnessPuts = new Map();
        /** @type {Set<string>} */
        const freshnessDels = new Set();
        /** @type {Map<string, InputsRecord>} */
        const inputsPuts = new Map();
        /** @type {Set<string>} */
        const inputsDels = new Set();
        /** @type {Map<string, NodeIdentifier[]>} */
        const revdepsPuts = new Map();
        /** @type {Set<string>} */
        const revdepsDels = new Set();
        /** @type {Map<string, Counter>} */
        const countersPuts = new Map();
        /** @type {Set<string>} */
        const countersDels = new Set();
        /** @type {Map<string, TimestampRecord>} */
        const timestampsPuts = new Map();
        /** @type {Set<string>} */
        const timestampsDels = new Set();

        /** @type {BatchBuilder} */
        const batch = {
            values: {
                put(key, value) {
                    const overlayKey = pendingKey(key);
                    valuesPuts.set(overlayKey, value);
                    valuesDels.delete(overlayKey);
                    operations.push(schemaStorage.values.putOp(toDatabaseKey(key), value));
                },
                del(key) {
                    const overlayKey = pendingKey(key);
                    valuesDels.add(overlayKey);
                    valuesPuts.delete(overlayKey);
                    operations.push(schemaStorage.values.delOp(toDatabaseKey(key)));
                },
                async get(key) {
                    const pending = readPendingValue(valuesPuts, valuesDels, key);
                    if (pending !== undefined || valuesDels.has(pendingKey(key))) {
                        return pending;
                    }
                    return await schemaStorage.values.get(toDatabaseKey(key));
                },
            },
            freshness: {
                put(key, value) {
                    const overlayKey = pendingKey(key);
                    freshnessPuts.set(overlayKey, value);
                    freshnessDels.delete(overlayKey);
                    operations.push(schemaStorage.freshness.putOp(toDatabaseKey(key), value));
                },
                del(key) {
                    const overlayKey = pendingKey(key);
                    freshnessDels.add(overlayKey);
                    freshnessPuts.delete(overlayKey);
                    operations.push(schemaStorage.freshness.delOp(toDatabaseKey(key)));
                },
                async get(key) {
                    const pending = readPendingValue(freshnessPuts, freshnessDels, key);
                    if (pending !== undefined || freshnessDels.has(pendingKey(key))) {
                        return pending;
                    }
                    return await schemaStorage.freshness.get(toDatabaseKey(key));
                },
            },
            inputs: {
                put(key, value) {
                    const overlayKey = pendingKey(key);
                    inputsPuts.set(overlayKey, value);
                    inputsDels.delete(overlayKey);
                    operations.push(schemaStorage.inputs.putOp(toDatabaseKey(key), {
                        inputs: value.inputs,
                        inputCounters: value.inputCounters,
                    }));
                },
                del(key) {
                    const overlayKey = pendingKey(key);
                    inputsDels.add(overlayKey);
                    inputsPuts.delete(overlayKey);
                    operations.push(schemaStorage.inputs.delOp(toDatabaseKey(key)));
                },
                async get(key) {
                    const pending = readPendingValue(inputsPuts, inputsDels, key);
                    if (pending !== undefined || inputsDels.has(pendingKey(key))) {
                        return pending;
                    }
                    return await schemaStorage.inputs.get(toDatabaseKey(key));
                },
            },
            revdeps: {
                put(key, value) {
                    const overlayKey = pendingKey(key);
                    revdepsPuts.set(overlayKey, value);
                    revdepsDels.delete(overlayKey);
                    operations.push(
                        schemaStorage.revdeps.putOp(
                            toDatabaseKey(key),
                            value.map(toDatabaseKey)
                        )
                    );
                },
                del(key) {
                    const overlayKey = pendingKey(key);
                    revdepsDels.add(overlayKey);
                    revdepsPuts.delete(overlayKey);
                    operations.push(schemaStorage.revdeps.delOp(toDatabaseKey(key)));
                },
                async get(key) {
                    const pending = readPendingValue(revdepsPuts, revdepsDels, key);
                    if (pending !== undefined || revdepsDels.has(pendingKey(key))) {
                        return pending;
                    }
                    const stored = await schemaStorage.revdeps.get(toDatabaseKey(key));
                    if (stored === undefined) {
                        return undefined;
                    }
                    return stored.map(databaseKeyToNodeIdentifier);
                },
            },
            counters: {
                put(key, value) {
                    const overlayKey = pendingKey(key);
                    countersPuts.set(overlayKey, value);
                    countersDels.delete(overlayKey);
                    operations.push(schemaStorage.counters.putOp(toDatabaseKey(key), value));
                },
                del(key) {
                    const overlayKey = pendingKey(key);
                    countersDels.add(overlayKey);
                    countersPuts.delete(overlayKey);
                    operations.push(schemaStorage.counters.delOp(toDatabaseKey(key)));
                },
                async get(key) {
                    const pending = readPendingValue(countersPuts, countersDels, key);
                    if (pending !== undefined || countersDels.has(pendingKey(key))) {
                        return pending;
                    }
                    return await schemaStorage.counters.get(toDatabaseKey(key));
                },
            },
            timestamps: {
                put(key, value) {
                    const overlayKey = pendingKey(key);
                    timestampsPuts.set(overlayKey, value);
                    timestampsDels.delete(overlayKey);
                    operations.push(schemaStorage.timestamps.putOp(toDatabaseKey(key), value));
                },
                del(key) {
                    const overlayKey = pendingKey(key);
                    timestampsDels.add(overlayKey);
                    timestampsPuts.delete(overlayKey);
                    operations.push(schemaStorage.timestamps.delOp(toDatabaseKey(key)));
                },
                async get(key) {
                    const pending = readPendingValue(timestampsPuts, timestampsDels, key);
                    if (pending !== undefined || timestampsDels.has(pendingKey(key))) {
                        return pending;
                    }
                    return await schemaStorage.timestamps.get(toDatabaseKey(key));
                },
            },
        };

        const value = await fn(batch);
        await schemaStorage.batch(operations);
        return value;
    };

    return withBatch;
}

/**
 * Create the identifier-native graph storage facade for one schema namespace.
 * @param {RootDatabase} rootDatabase
 * @returns {GraphStorage}
 */
function makeGraphStorage(rootDatabase) {
    const schemaStorage = rootDatabase.getSchemaStorage();
    const withBatch = makeBatchBuilder(schemaStorage);

    /**
     * @param {IdentifierDatabase<*>} database
     * @returns {IdentifierDatabase<*>}
     */
    function makeIdentifierDatabase(database) {
        return {
            async get(key) {
                return await database.get(key);
            },
            async put(key, value) {
                await database.put(key, value);
            },
            async del(key) {
                await database.del(key);
            },
            async *keys() {
                for await (const key of database.keys()) {
                    yield key;
                }
            },
        };
    }

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
        return record.inputs.map((input) => nodeIdentifierFromString(input));
    }

    /**
     * @returns {Promise<NodeIdentifier[]>}
     */
    async function listMaterializedNodes() {
        const nodes = [];
        for await (const key of schemaStorage.inputs.keys()) {
            nodes.push(databaseKeyToNodeIdentifier(key));
        }
        return nodes;
    }

    return {
        values: makeIdentifierDatabase({
            async get(key) { return await schemaStorage.values.get(toDatabaseKey(key)); },
            async put(key, value) { await schemaStorage.values.put(toDatabaseKey(key), value); },
            async del(key) { await schemaStorage.values.del(toDatabaseKey(key)); },
            async *keys() { for await (const key of schemaStorage.values.keys()) { yield databaseKeyToNodeIdentifier(key); } },
        }),
        freshness: makeIdentifierDatabase({
            async get(key) { return await schemaStorage.freshness.get(toDatabaseKey(key)); },
            async put(key, value) { await schemaStorage.freshness.put(toDatabaseKey(key), value); },
            async del(key) { await schemaStorage.freshness.del(toDatabaseKey(key)); },
            async *keys() { for await (const key of schemaStorage.freshness.keys()) { yield databaseKeyToNodeIdentifier(key); } },
        }),
        inputs: makeIdentifierDatabase({
            async get(key) { return await schemaStorage.inputs.get(toDatabaseKey(key)); },
            async put(key, value) { await schemaStorage.inputs.put(toDatabaseKey(key), value); },
            async del(key) { await schemaStorage.inputs.del(toDatabaseKey(key)); },
            async *keys() { for await (const key of schemaStorage.inputs.keys()) { yield databaseKeyToNodeIdentifier(key); } },
        }),
        revdeps: makeIdentifierDatabase({
            async get(key) {
                const stored = await schemaStorage.revdeps.get(toDatabaseKey(key));
                return stored === undefined ? undefined : stored.map(databaseKeyToNodeIdentifier);
            },
            async put(key, value) {
                await schemaStorage.revdeps.put(toDatabaseKey(key), value.map(toDatabaseKey));
            },
            async del(key) { await schemaStorage.revdeps.del(toDatabaseKey(key)); },
            async *keys() { for await (const key of schemaStorage.revdeps.keys()) { yield databaseKeyToNodeIdentifier(key); } },
        }),
        counters: makeIdentifierDatabase({
            async get(key) { return await schemaStorage.counters.get(toDatabaseKey(key)); },
            async put(key, value) { await schemaStorage.counters.put(toDatabaseKey(key), value); },
            async del(key) { await schemaStorage.counters.del(toDatabaseKey(key)); },
            async *keys() { for await (const key of schemaStorage.counters.keys()) { yield databaseKeyToNodeIdentifier(key); } },
        }),
        timestamps: makeIdentifierDatabase({
            async get(key) { return await schemaStorage.timestamps.get(toDatabaseKey(key)); },
            async put(key, value) { await schemaStorage.timestamps.put(toDatabaseKey(key), value); },
            async del(key) { await schemaStorage.timestamps.del(toDatabaseKey(key)); },
            async *keys() { for await (const key of schemaStorage.timestamps.keys()) { yield databaseKeyToNodeIdentifier(key); } },
        }),
        withBatch,
        ensureMaterialized,
        ensureReverseDepsIndexed,
        listDependents,
        getInputs,
        listMaterializedNodes,
    };
}

module.exports = {
    makeGraphStorage,
};
