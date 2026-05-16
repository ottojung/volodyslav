/* eslint volodyslav/max-lines-per-file: "off" */
/**
 * GraphStorage module.
 * Encapsulates database access for the incremental graph using typed sublevels.
 */

const {
    IDENTIFIERS_KEY,
    allocateNodeIdentifier,
    cloneIdentifierLookup,
    makeEmptyIdentifierLookup,
    nodeIdentifierFromString,
    nodeIdentifierToString,
    nodeIdToKeyFromLookup,
    nodeKeyToIdFromLookup,
    requireNodeIdentifierForKey,
    requireNodeKeyForIdentifier,
    serializeIdentifierLookup,
    setIdentifierMapping,
    stringToNodeKeyString,
} = require("./database");
const { nodeKeyStringToString } = require("./database");

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
/** @typedef {import('./types').NodeKeyString} NodeKeyString */
/** @typedef {import('./database/identifier_lookup').IdentifierLookup} IdentifierLookup */
/** @typedef {import('./database/node_identifier').NodeIdentifier} NodeIdentifier */

/**
 * @template TValue
 * @typedef {object} SemanticDatabase
 * @property {(key: NodeKeyString) => Promise<TValue | undefined>} get
 * @property {(key: NodeKeyString, value: TValue) => Promise<void>} put
 * @property {(key: NodeKeyString) => Promise<void>} del
 * @property {() => AsyncIterable<NodeKeyString>} keys
 */

/**
 * Interface for batch operations on a specific database.
 * @template TValue
 * @typedef {object} BatchDatabaseOps
 * @property {(key: NodeKeyString, value: TValue) => void} put
 * @property {(key: NodeKeyString) => void} del
 * @property {(key: NodeKeyString) => Promise<TValue | undefined>} get
 */

/**
 * @typedef {object} BatchBuilder
 * @property {BatchDatabaseOps<ComputedValue>} values
 * @property {BatchDatabaseOps<Freshness>} freshness
 * @property {BatchDatabaseOps<InputsRecord>} inputs
 * @property {BatchDatabaseOps<NodeKeyString[]>} revdeps
 * @property {BatchDatabaseOps<Counter>} counters
 * @property {BatchDatabaseOps<TimestampRecord>} timestamps
 * @property {IdentifierLookup} identifierLookup
 */

/**
 * @typedef {<T>(fn: (batch: BatchBuilder) => Promise<T>) => Promise<T>} BatchFunction
 */

/**
 * GraphStorage exposes semantic-keyed databases while persisting identifier-keyed state.
 * @typedef {object} GraphStorage
 * @property {SemanticDatabase<ComputedValue>} values
 * @property {SemanticDatabase<Freshness>} freshness
 * @property {SemanticDatabase<InputsRecord>} inputs
 * @property {SemanticDatabase<NodeKeyString[]>} revdeps
 * @property {SemanticDatabase<Counter>} counters
 * @property {SemanticDatabase<TimestampRecord>} timestamps
 * @property {BatchFunction} withBatch
 * @property {(node: NodeKeyString, inputs: NodeKeyString[], inputCounters: number[], batch: BatchBuilder) => Promise<void>} ensureMaterialized
 * @property {(node: NodeKeyString, inputs: NodeKeyString[], batch: BatchBuilder) => Promise<void>} ensureReverseDepsIndexed
 * @property {(input: NodeKeyString, batch: BatchBuilder) => Promise<NodeKeyString[]>} listDependents
 * @property {(node: NodeKeyString, batch: BatchBuilder) => Promise<NodeKeyString[] | null>} getInputs
 * @property {() => Promise<NodeKeyString[]>} listMaterializedNodes
 */

/**
 * @param {NodeKeyString} nodeKey
 * @returns {string}
 */
function nodeKeyStringKey(nodeKey) {
    return nodeKeyStringToString(nodeKey);
}

/**
 * @param {RootDatabase} rootDatabase
 * @param {IdentifierLookup} identifierLookup
 * @param {NodeKeyString} nodeKey
 * @returns {NodeIdentifier}
 */
function getOrAllocateNodeIdentifier(rootDatabase, identifierLookup, nodeKey) {
    return allocateNodeIdentifier(
        identifierLookup,
        nodeKey,
        () => rootDatabase.generateNodeIdentifier()
    );
}

/**
 * @param {IdentifierLookup} identifierLookup
 * @param {NodeKeyString} nodeKey
 * @returns {NodeIdentifier | undefined}
 */
function lookupNodeIdentifier(identifierLookup, nodeKey) {
    try {
        return requireNodeIdentifierForKey(identifierLookup, nodeKey);
    } catch (_error) {
        return undefined;
    }
}

/**
 * @param {RootDatabase | null} rootDatabase
 * @param {IdentifierLookup} identifierLookup
 * @param {string[]} identifiers
 * @returns {NodeKeyString[]}
 */
function translateStoredIdentifiersToNodeKeys(rootDatabase, identifierLookup, identifiers) {
    return identifiers.map((identifierString) => {
        const nodeIdentifier = nodeIdentifierFromString(String(identifierString));
        try {
            return requireNodeKeyForIdentifier(identifierLookup, nodeIdentifier);
        } catch (_error) {
            if (rootDatabase !== null && typeof rootDatabase.nodeIdToKey === "function") {
                const committedNodeKey = rootDatabase.nodeIdToKey(nodeIdentifier);
                if (committedNodeKey !== undefined) {
                    setIdentifierMapping(identifierLookup, nodeIdentifier, committedNodeKey);
                    return committedNodeKey;
                }
            }
            throw _error;
        }
    });
}

/**
 * @param {IdentifierLookup} identifierLookup
 * @param {NodeKeyString[]} nodeKeys
 * @param {boolean} allowAllocate
 * @param {RootDatabase} rootDatabase
 * @returns {string[]}
 */
function translateNodeKeysToStoredIdentifiers(
    identifierLookup,
    nodeKeys,
    allowAllocate,
    rootDatabase
) {
    return nodeKeys.map((nodeKey) => {
        if (allowAllocate) {
            return nodeIdentifierToString(
                getOrAllocateNodeIdentifier(rootDatabase, identifierLookup, nodeKey)
            );
        }
        return nodeIdentifierToString(
            requireNodeIdentifierForKey(identifierLookup, nodeKey)
        );
    });
}

/**
 * @param {NodeIdentifier} nodeIdentifier
 * @returns {NodeKeyString}
 */
function nodeIdentifierToStoredKey(nodeIdentifier) {
    return stringToNodeKeyString(nodeIdentifierToString(nodeIdentifier));
}

/**
 * @param {string[]} sortedArray
 * @param {string} node
 * @returns {{ index: number, found: boolean }}
 */
function findInsertionIndex(sortedArray, node) {
    let lo = 0;
    let hi = sortedArray.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const midVal = sortedArray[mid];
        if (midVal === undefined) {
            throw new Error("findInsertionIndex: unexpected undefined element at index " + String(mid));
        }
        const cmp = midVal < node ? -1 : midVal > node ? 1 : 0;
        if (cmp === 0) {
            return { index: mid, found: true };
        }
        if (cmp < 0) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return { index: lo, found: false };
}

/**
 * @template TValue
 * @param {Map<string, TValue>} pendingPuts
 * @param {Set<string>} pendingDels
 * @param {NodeKeyString} key
 * @returns {TValue | undefined}
 */
function readPendingValue(pendingPuts, pendingDels, key) {
    const semanticKey = nodeKeyStringKey(key);
    if (pendingDels.has(semanticKey)) {
        return undefined;
    }
    return pendingPuts.get(semanticKey);
}

/**
 * @param {SchemaStorage} schemaStorage
 * @param {RootDatabase} rootDatabase
 * @returns {BatchFunction}
 */
function makeBatchBuilder(schemaStorage, rootDatabase) {
    /** @type {BatchFunction} */
    const ret = async (fn) => {
        const identifierLookup = cloneIdentifierLookup(rootDatabase.cloneActiveIdentifierLookup());
        let identifiersDirty = false;
        let identifierMappingsChanged = false;

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
        /** @type {Map<string, NodeKeyString[]>} */
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

        /**
         * @param {NodeKeyString} key
         * @param {boolean} allowAllocate
         * @returns {NodeKeyString | undefined}
         */
        function resolveIdentifier(key, allowAllocate) {
            const existing = lookupNodeIdentifier(identifierLookup, key);
            if (existing !== undefined) {
                return nodeIdentifierToStoredKey(existing);
            }
            if (typeof rootDatabase.nodeKeyToId === "function") {
                const committedIdentifier = rootDatabase.nodeKeyToId(key);
                if (committedIdentifier !== undefined) {
                    setIdentifierMapping(identifierLookup, committedIdentifier, key);
                    return nodeIdentifierToStoredKey(committedIdentifier);
                }
            }
            if (!allowAllocate) {
                return undefined;
            }
            identifiersDirty = true;
            identifierMappingsChanged = true;
            return nodeIdentifierToStoredKey(
                getOrAllocateNodeIdentifier(rootDatabase, identifierLookup, key)
            );
        }

        /** @returns {void} */
        function queueIdentifiersWrite() {
            if (!identifiersDirty) {
                return;
            }
            operations.push(
                schemaStorage.global.rawPutOp(
                    IDENTIFIERS_KEY,
                    serializeIdentifierLookup(identifierLookup)
                )
            );
            identifiersDirty = false;
        }

        /** @type {BatchBuilder & { identifierLookup: IdentifierLookup, markIdentifiersDirty: () => void }} */
        const builder = {
            identifierLookup,
            markIdentifiersDirty: () => {
                identifiersDirty = true;
                identifierMappingsChanged = true;
            },
            values: {
                put: (key, value) => {
                    const semanticKey = nodeKeyStringKey(key);
                    const nodeIdentifier = resolveIdentifier(key, true);
                    if (nodeIdentifier === undefined) {
                        throw new Error(`Missing node identifier for ${semanticKey}`);
                    }
                    valuesPuts.set(semanticKey, value);
                    valuesDels.delete(semanticKey);
                    operations.push(schemaStorage.values.putOp(nodeIdentifier, value));
                },
                del: (key) => {
                    const semanticKey = nodeKeyStringKey(key);
                    const nodeIdentifier = resolveIdentifier(key, false);
                    valuesDels.add(semanticKey);
                    valuesPuts.delete(semanticKey);
                    if (nodeIdentifier !== undefined) {
                        operations.push(schemaStorage.values.delOp(nodeIdentifier));
                    }
                },
                get: async (key) => {
                    const pending = readPendingValue(valuesPuts, valuesDels, key);
                    if (pending !== undefined || valuesDels.has(nodeKeyStringKey(key))) {
                        return pending;
                    }
                    const nodeIdentifier = resolveIdentifier(key, false);
                    if (nodeIdentifier === undefined) {
                        return undefined;
                    }
                    return await schemaStorage.values.get(nodeIdentifier);
                },
            },
            freshness: {
                put: (key, value) => {
                    const semanticKey = nodeKeyStringKey(key);
                    const nodeIdentifier = resolveIdentifier(key, true);
                    if (nodeIdentifier === undefined) {
                        throw new Error(`Missing node identifier for ${semanticKey}`);
                    }
                    freshnessPuts.set(semanticKey, value);
                    freshnessDels.delete(semanticKey);
                    operations.push(schemaStorage.freshness.putOp(nodeIdentifier, value));
                },
                del: (key) => {
                    const semanticKey = nodeKeyStringKey(key);
                    const nodeIdentifier = resolveIdentifier(key, false);
                    freshnessDels.add(semanticKey);
                    freshnessPuts.delete(semanticKey);
                    if (nodeIdentifier !== undefined) {
                        operations.push(schemaStorage.freshness.delOp(nodeIdentifier));
                    }
                },
                get: async (key) => {
                    const pending = readPendingValue(freshnessPuts, freshnessDels, key);
                    if (pending !== undefined || freshnessDels.has(nodeKeyStringKey(key))) {
                        return pending;
                    }
                    const nodeIdentifier = resolveIdentifier(key, false);
                    if (nodeIdentifier === undefined) {
                        return undefined;
                    }
                    return await schemaStorage.freshness.get(nodeIdentifier);
                },
            },
            inputs: {
                put: (key, value) => {
                    const semanticKey = nodeKeyStringKey(key);
                    const nodeIdentifier = resolveIdentifier(key, true);
                    if (nodeIdentifier === undefined) {
                        throw new Error(`Missing node identifier for ${semanticKey}`);
                    }
                    const translatedInputs = translateNodeKeysToStoredIdentifiers(
                        identifierLookup,
                        value.inputs.map(stringToNodeKeyString),
                        false,
                        rootDatabase
                    );
                    inputsPuts.set(semanticKey, value);
                    inputsDels.delete(semanticKey);
                    operations.push(
                        schemaStorage.inputs.putOp(nodeIdentifier, {
                            inputs: translatedInputs,
                            inputCounters: value.inputCounters,
                        })
                    );
                },
                del: (key) => {
                    const semanticKey = nodeKeyStringKey(key);
                    const nodeIdentifier = resolveIdentifier(key, false);
                    inputsDels.add(semanticKey);
                    inputsPuts.delete(semanticKey);
                    if (nodeIdentifier !== undefined) {
                        operations.push(schemaStorage.inputs.delOp(nodeIdentifier));
                    }
                },
                get: async (key) => {
                    const pending = readPendingValue(inputsPuts, inputsDels, key);
                    if (pending !== undefined || inputsDels.has(nodeKeyStringKey(key))) {
                        return pending;
                    }
                    const nodeIdentifier = resolveIdentifier(key, false);
                    if (nodeIdentifier === undefined) {
                        return undefined;
                    }
                    const record = await schemaStorage.inputs.get(nodeIdentifier);
                    if (record === undefined) {
                        return undefined;
                    }
                    return {
                        inputs: translateStoredIdentifiersToNodeKeys(
                            rootDatabase,
                            identifierLookup,
                            record.inputs
                        ).map(nodeKeyStringToString),
                        inputCounters: record.inputCounters,
                    };
                },
            },
            revdeps: {
                put: (key, value) => {
                    const semanticKey = nodeKeyStringKey(key);
                    const nodeIdentifier = resolveIdentifier(key, false);
                    if (nodeIdentifier === undefined) {
                        throw new Error(`Missing input node identifier for ${semanticKey}`);
                    }
                    const translatedDependents = translateNodeKeysToStoredIdentifiers(
                        identifierLookup,
                        value,
                        true,
                        rootDatabase
                    );
                    revdepsPuts.set(semanticKey, value);
                    revdepsDels.delete(semanticKey);
                    operations.push(
                        schemaStorage.revdeps.putOp(
                            nodeIdentifier,
                            translatedDependents.map(stringToNodeKeyString)
                        )
                    );
                },
                del: (key) => {
                    const semanticKey = nodeKeyStringKey(key);
                    const nodeIdentifier = resolveIdentifier(key, false);
                    revdepsDels.add(semanticKey);
                    revdepsPuts.delete(semanticKey);
                    if (nodeIdentifier !== undefined) {
                        operations.push(schemaStorage.revdeps.delOp(nodeIdentifier));
                    }
                },
                get: async (key) => {
                    const pending = readPendingValue(revdepsPuts, revdepsDels, key);
                    if (pending !== undefined || revdepsDels.has(nodeKeyStringKey(key))) {
                        return pending;
                    }
                    const nodeIdentifier = resolveIdentifier(key, false);
                    if (nodeIdentifier === undefined) {
                        return undefined;
                    }
                    const dependents = await schemaStorage.revdeps.get(nodeIdentifier);
                    if (dependents === undefined) {
                        return undefined;
                    }
                    return translateStoredIdentifiersToNodeKeys(
                        rootDatabase,
                        identifierLookup,
                        dependents.map(nodeKeyStringToString)
                    );
                },
            },
            counters: {
                put: (key, value) => {
                    const semanticKey = nodeKeyStringKey(key);
                    const nodeIdentifier = resolveIdentifier(key, true);
                    if (nodeIdentifier === undefined) {
                        throw new Error(`Missing node identifier for ${semanticKey}`);
                    }
                    countersPuts.set(semanticKey, value);
                    countersDels.delete(semanticKey);
                    operations.push(schemaStorage.counters.putOp(nodeIdentifier, value));
                },
                del: (key) => {
                    const semanticKey = nodeKeyStringKey(key);
                    const nodeIdentifier = resolveIdentifier(key, false);
                    countersDels.add(semanticKey);
                    countersPuts.delete(semanticKey);
                    if (nodeIdentifier !== undefined) {
                        operations.push(schemaStorage.counters.delOp(nodeIdentifier));
                    }
                },
                get: async (key) => {
                    const pending = readPendingValue(countersPuts, countersDels, key);
                    if (pending !== undefined || countersDels.has(nodeKeyStringKey(key))) {
                        return pending;
                    }
                    const nodeIdentifier = resolveIdentifier(key, false);
                    if (nodeIdentifier === undefined) {
                        return undefined;
                    }
                    return await schemaStorage.counters.get(nodeIdentifier);
                },
            },
            timestamps: {
                put: (key, value) => {
                    const semanticKey = nodeKeyStringKey(key);
                    const nodeIdentifier = resolveIdentifier(key, true);
                    if (nodeIdentifier === undefined) {
                        throw new Error(`Missing node identifier for ${semanticKey}`);
                    }
                    timestampsPuts.set(semanticKey, value);
                    timestampsDels.delete(semanticKey);
                    operations.push(schemaStorage.timestamps.putOp(nodeIdentifier, value));
                },
                del: (key) => {
                    const semanticKey = nodeKeyStringKey(key);
                    const nodeIdentifier = resolveIdentifier(key, false);
                    timestampsDels.add(semanticKey);
                    timestampsPuts.delete(semanticKey);
                    if (nodeIdentifier !== undefined) {
                        operations.push(schemaStorage.timestamps.delOp(nodeIdentifier));
                    }
                },
                get: async (key) => {
                    const pending = readPendingValue(timestampsPuts, timestampsDels, key);
                    if (pending !== undefined || timestampsDels.has(nodeKeyStringKey(key))) {
                        return pending;
                    }
                    const nodeIdentifier = resolveIdentifier(key, false);
                    if (nodeIdentifier === undefined) {
                        return undefined;
                    }
                    return await schemaStorage.timestamps.get(nodeIdentifier);
                },
            },
        };

        const value = await fn(builder);
        queueIdentifiersWrite();
        await schemaStorage.batch(operations);
        if (identifierMappingsChanged) {
            const committedLookup = rootDatabase.cloneActiveIdentifierLookup();
            for (const [nodeIdentifier, nodeKey] of serializeIdentifierLookup(identifierLookup)) {
                const existingKey = nodeIdToKeyFromLookup(committedLookup, nodeIdentifier);
                const existingIdentifier = nodeKeyToIdFromLookup(committedLookup, nodeKey);
                if (existingKey === undefined && existingIdentifier === undefined) {
                    setIdentifierMapping(committedLookup, nodeIdentifier, nodeKey);
                }
            }
            rootDatabase.replaceActiveIdentifierLookup(committedLookup);
        }
        return value;
    };

    return ret;
}

/**
 * @param {RootDatabase} rootDatabase
 * @param {SchemaStorage} schemaStorage
 * @param {ValuesDatabase | FreshnessDatabase | InputsDatabase | RevdepsDatabase | CountersDatabase | TimestampsDatabase} rawDatabase
 * @param {'values' | 'freshness' | 'inputs' | 'revdeps' | 'counters' | 'timestamps'} kind
 * @returns {SemanticDatabase<*>}
 */
function makeSemanticDatabase(rootDatabase, schemaStorage, rawDatabase, kind) {
    /** @type {SemanticDatabase<*>} */
    const storage = {
        async get(/** @type {NodeKeyString} */ key) {
            const identifier = rootDatabase.nodeKeyToId(key);
            if (identifier === undefined) {
                return undefined;
            }
            const value = await rawDatabase.get(nodeIdentifierToStoredKey(identifier));
            if (value === undefined) {
                return undefined;
            }
            if (
                kind === 'inputs' &&
                typeof value === 'object' &&
                value !== null &&
                !Array.isArray(value) &&
                'inputs' in value &&
                'inputCounters' in value
            ) {
                return {
                    inputs: translateStoredIdentifiersToNodeKeys(
                        rootDatabase,
                        rootDatabase.cloneActiveIdentifierLookup(),
                        value.inputs
                    ).map(nodeKeyStringToString),
                    inputCounters: value.inputCounters,
                };
            }
            if (kind === 'revdeps' && Array.isArray(value)) {
                return translateStoredIdentifiersToNodeKeys(
                    rootDatabase,
                    rootDatabase.cloneActiveIdentifierLookup(),
                    value.map(nodeKeyStringToString)
                );
            }
            return value;
        },
        async put(/** @type {NodeKeyString} */ key, /** @type {*} */ value) {
            await makeBatchBuilder(schemaStorage, rootDatabase)(async (batch) => {
                if (kind === 'values') {
                    batch.values.put(key, value);
                } else if (kind === 'freshness') {
                    batch.freshness.put(key, value);
                } else if (kind === 'inputs') {
                    batch.inputs.put(key, value);
                } else if (kind === 'revdeps') {
                    batch.revdeps.put(key, value);
                } else if (kind === 'counters') {
                    batch.counters.put(key, value);
                } else {
                    batch.timestamps.put(key, value);
                }
            });
        },
        async del(/** @type {NodeKeyString} */ key) {
            await makeBatchBuilder(schemaStorage, rootDatabase)(async (batch) => {
                if (kind === 'values') {
                    batch.values.del(key);
                } else if (kind === 'freshness') {
                    batch.freshness.del(key);
                } else if (kind === 'inputs') {
                    batch.inputs.del(key);
                } else if (kind === 'revdeps') {
                    batch.revdeps.del(key);
                } else if (kind === 'counters') {
                    batch.counters.del(key);
                } else {
                    batch.timestamps.del(key);
                }
            });
        },
        async *keys() {
            for await (const rawKey of rawDatabase.keys()) {
                yield requireNodeKeyForIdentifier(
                    rootDatabase.cloneActiveIdentifierLookup(),
                    nodeIdentifierFromString(nodeKeyStringToString(rawKey))
                );
            }
        },
    };
    return storage;
}

/**
 * @param {SchemaStorage} schemaStorage
 * @returns {GraphStorage}
 */
function makeLegacyGraphStorage(schemaStorage) {
    /** @type {BatchFunction} */
    const withBatch = async (fn) => {
        /** @type {Array<*>} */
        const operations = [];
        /** @type {Map<string, *>} */
        const puts = new Map();
        /** @type {Set<string>} */
        const dels = new Set();

        /**
         * @template TValue
         * @param {ValuesDatabase | FreshnessDatabase | InputsDatabase | RevdepsDatabase | CountersDatabase | TimestampsDatabase} database
         * @returns {BatchDatabaseOps<TValue>}
         */
        function tx(database) {
            return {
                put(key, value) {
                    const semanticKey = nodeKeyStringKey(key);
                    puts.set(`${database}:${semanticKey}`, value);
                    dels.delete(`${database}:${semanticKey}`);
                    operations.push(database.putOp(key, value));
                },
                del(key) {
                    const semanticKey = nodeKeyStringKey(key);
                    dels.add(`${database}:${semanticKey}`);
                    puts.delete(`${database}:${semanticKey}`);
                    operations.push(database.delOp(key));
                },
                async get(key) {
                    const semanticKey = `${database}:${nodeKeyStringKey(key)}`;
                    if (dels.has(semanticKey)) {
                        return undefined;
                    }
                    if (puts.has(semanticKey)) {
                        return puts.get(semanticKey);
                    }
                    return await database.get(key);
                },
            };
        }

        /** @type {BatchBuilder} */
        const batch = {
            values: tx(schemaStorage.values),
            freshness: tx(schemaStorage.freshness),
            inputs: tx(schemaStorage.inputs),
            revdeps: tx(schemaStorage.revdeps),
            counters: tx(schemaStorage.counters),
            timestamps: tx(schemaStorage.timestamps),
            identifierLookup: makeEmptyIdentifierLookup(),
        };
        const result = await fn(batch);
        await schemaStorage.batch(operations);
        return result;
    };

    async function ensureMaterialized(node, inputs, inputCounters, batch) {
        batch.inputs.put(node, {
            inputs: inputs.map(nodeKeyStringToString),
            inputCounters,
        });
    }

    async function ensureReverseDepsIndexed(node, inputs, batch) {
        for (const input of inputs) {
            const existingDependents = await batch.revdeps.get(input);
            if (existingDependents !== undefined) {
                const { index, found } = findInsertionIndex(
                    existingDependents.map(nodeKeyStringToString),
                    nodeKeyStringToString(node)
                );
                if (found) {
                    continue;
                }
                batch.revdeps.put(input, [
                    ...existingDependents.slice(0, index),
                    node,
                    ...existingDependents.slice(index),
                ]);
            } else {
                batch.revdeps.put(input, [node]);
            }
        }
    }

    async function listDependents(input, batch) {
        return (await batch.revdeps.get(input)) ?? [];
    }

    async function getInputs(node, batch) {
        const record = await batch.inputs.get(node);
        if (!record) {
            return null;
        }
        return record.inputs.map(stringToNodeKeyString);
    }

    async function listMaterializedNodes() {
        const nodes = [];
        for await (const key of schemaStorage.inputs.keys()) {
            nodes.push(key);
        }
        return nodes;
    }

    return {
        values: schemaStorage.values,
        freshness: schemaStorage.freshness,
        inputs: schemaStorage.inputs,
        revdeps: schemaStorage.revdeps,
        counters: schemaStorage.counters,
        timestamps: schemaStorage.timestamps,
        withBatch,
        ensureMaterialized,
        ensureReverseDepsIndexed,
        listDependents,
        getInputs,
        listMaterializedNodes,
    };
}

/**
 * @param {RootDatabase} rootDatabase
 * @returns {GraphStorage}
 */
function makeGraphStorage(rootDatabase) {
    const schemaStorage = rootDatabase.getSchemaStorage();
    if (
        typeof rootDatabase.cloneActiveIdentifierLookup !== "function" ||
        typeof rootDatabase.nodeKeyToId !== "function" ||
        typeof rootDatabase.replaceActiveIdentifierLookup !== "function"
    ) {
        return makeLegacyGraphStorage(schemaStorage);
    }

    /** @type {BatchFunction} */
    const withBatch = makeBatchBuilder(schemaStorage, rootDatabase);

    /**
     * @param {NodeKeyString} node
     * @param {NodeKeyString[]} inputs
     * @param {number[]} inputCounters
     * @param {BatchBuilder} batch
     * @returns {Promise<void>}
     */
    async function ensureMaterialized(node, inputs, inputCounters, batch) {
        if (inputs.length !== inputCounters.length) {
            throw new Error(
                `ensureMaterialized: inputs length (${inputs.length}) must match inputCounters length (${inputCounters.length}) for node ${node}`
            );
        }

        batch.inputs.put(node, {
            inputs: inputs.map(nodeKeyStringToString),
            inputCounters,
        });
    }

    /**
     * @param {NodeKeyString} node
     * @param {NodeKeyString[]} inputs
     * @param {BatchBuilder} batch
     * @returns {Promise<void>}
     */
    async function ensureReverseDepsIndexed(node, inputs, batch) {
        const identifierLookup = batch.identifierLookup;
        const hadNodeIdentifier = lookupNodeIdentifier(identifierLookup, node) !== undefined;
        const nodeIdentifier = nodeIdentifierToString(
            getOrAllocateNodeIdentifier(rootDatabase, identifierLookup, node)
        );
        if (!hadNodeIdentifier) {
            batch.markIdentifiersDirty();
        }

        for (const input of inputs) {
            if (rootDatabase.nodeKeyToId(input) === undefined) {
                throw new Error(`Missing node identifier for input ${nodeKeyStringKey(input)}`);
            }
            const existingDependents = await batch.revdeps.get(input);
            if (existingDependents !== undefined) {
                const existingIdentifiers = translateNodeKeysToStoredIdentifiers(
                    identifierLookup,
                    existingDependents,
                    false,
                    rootDatabase
                );
                const { index, found } = findInsertionIndex(existingIdentifiers, nodeIdentifier);
                if (found) {
                    continue;
                }
                const newDependents = [
                    ...existingDependents.slice(0, index),
                    node,
                    ...existingDependents.slice(index),
                ];
                batch.revdeps.put(input, newDependents);
                continue;
            }
            batch.revdeps.put(input, [node]);
        }
    }

    /**
     * @param {NodeKeyString} input
     * @param {BatchBuilder} batch
     * @returns {Promise<NodeKeyString[]>}
     */
    async function listDependents(input, batch) {
        const dependents = await batch.revdeps.get(input);
        if (dependents === undefined) {
            return [];
        }
        return dependents;
    }

    /**
     * @param {NodeKeyString} node
     * @param {BatchBuilder} batch
     * @returns {Promise<NodeKeyString[] | null>}
     */
    async function getInputs(node, batch) {
        const record = await batch.inputs.get(node);
        if (!record) {
            return null;
        }
        return record.inputs.map(stringToNodeKeyString);
    }

    /**
     * @returns {Promise<NodeKeyString[]>}
     */
    async function listMaterializedNodes() {
        const nodes = [];
        const identifierLookup = rootDatabase.cloneActiveIdentifierLookup();
        for await (const rawKey of schemaStorage.inputs.keys()) {
            nodes.push(
                requireNodeKeyForIdentifier(
                    identifierLookup,
                    nodeIdentifierFromString(nodeKeyStringToString(rawKey))
                )
            );
        }
        return nodes;
    }

    return {
        values: makeSemanticDatabase(rootDatabase, schemaStorage, schemaStorage.values, 'values'),
        freshness: makeSemanticDatabase(rootDatabase, schemaStorage, schemaStorage.freshness, 'freshness'),
        inputs: makeSemanticDatabase(rootDatabase, schemaStorage, schemaStorage.inputs, 'inputs'),
        revdeps: makeSemanticDatabase(rootDatabase, schemaStorage, schemaStorage.revdeps, 'revdeps'),
        counters: makeSemanticDatabase(rootDatabase, schemaStorage, schemaStorage.counters, 'counters'),
        timestamps: makeSemanticDatabase(rootDatabase, schemaStorage, schemaStorage.timestamps, 'timestamps'),
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
