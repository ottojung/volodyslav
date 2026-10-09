/**
 * Test helper to create a semantic-key database interface.
 *
 * Usage:
 *   const db = await getRootDatabase(capabilities);
 *   const graphDef = [..];
 *   const graph = await createIncrementalGraph(db, graphDef);
 *   const testDb = makeTestDatabase(graph);
 *
 *   await testDb.put("key", value);
 *   await testDb.put("key", "up-to-date");
 */

const {
    createNodeKeyFromPattern,
    serializeNodeKey,
} = require("../src/generators/incremental_graph/database/node_key");
const { functor } = require("../src/generators/incremental_graph/expr");
const { isJsonKey } = require("./test_json_key_helper");
/** @typedef {import('../src/generators/incremental_graph/database/types').NodeIdentifier} NodeIdentifier */

const {
    IDENTIFIERS_KEY,
    LAST_NODE_INDEX_KEY,
    commitTransactionLookup,
    compareNodeIdentifier,
    makeTransactionIdentifierLookup,
    nodeIdentifierToString,
    serializeTransactionLookup,
    txAllocateNodeIdentifier,
} = require("../src/generators/incremental_graph/database");

/**
 * Converts a node name to JSON key format if needed.
 * @param {string} key
 * @returns {string}
 */
function toJsonKey(key) {
    // If already a valid JSON key, return as-is
    if (isJsonKey(key)) {
        return key;
    }
    const head = functor(key);
    const nodeKey = createNodeKeyFromPattern(head, []);
    const nodeKeyString = serializeNodeKey(nodeKey);
    return nodeKeyString;
}

/**
 * Look up the identifier of a seeded node key, or undefined when the key is unknown.
 * @param {SeedingTransaction} tx
 * @param {string} jsonKey
 * @returns {NodeIdentifier | undefined}
 */
function lookupSeededIdentifier(tx, jsonKey) {
    return tx.identifierLookup.keyToId.get(jsonKey) ?? tx.identifierLookup.base.keyToId.get(jsonKey);
}

/**
 * Convert a seeded identifier back to the semantic node key it names.
 * @param {SeedingTransaction} tx
 * @param {NodeIdentifier} nodeIdentifier
 * @returns {string}
 */
function requireSeededNodeKey(tx, nodeIdentifier) {
    const keyString = nodeIdentifierToString(nodeIdentifier);
    const nodeKey =
        tx.identifierLookup.idToKey.get(keyString) ?? tx.identifierLookup.base.idToKey.get(keyString);
    if (nodeKey === undefined) {
        throw new Error(`Missing semantic node key for identifier ${keyString}`);
    }
    return nodeKey;
}

/**
 * Allocate an identifier for a node key being seeded.
 * @param {import('../src/generators/incremental_graph').IncrementalGraph} graph
 * @param {SeedingTransaction} tx
 * @param {string} jsonKey
 * @returns {NodeIdentifier}
 */
function allocateSeededIdentifier(graph, tx, jsonKey) {
    return txAllocateNodeIdentifier(
        tx.identifierLookup,
        jsonKey,
        () => graph.rootDatabase.generateNodeIdentifier(),
        graph.rootDatabase
    );
}

/**
 * Read-your-writes batch operations for one seeded sublevel.
 * @param {{get: (key: NodeIdentifier) => Promise<any>, putOp: (key: NodeIdentifier, value: any) => object, delOp: (key: NodeIdentifier) => object}} database
 * @param {Array<object>} operations
 * @returns {{put: (key: NodeIdentifier, value: any) => void, del: (key: NodeIdentifier) => void, get: (key: NodeIdentifier) => Promise<any>}}
 */
function makeSeededSublevelBatch(database, operations) {
    /** @type {Map<string, any>} */
    const puts = new Map();
    /** @type {Set<string>} */
    const dels = new Set();
    return {
        put(key, value) {
            const keyString = nodeIdentifierToString(key);
            puts.set(keyString, value);
            dels.delete(keyString);
            operations.push(database.putOp(key, value));
        },
        del(key) {
            const keyString = nodeIdentifierToString(key);
            dels.add(keyString);
            puts.delete(keyString);
            operations.push(database.delOp(key));
        },
        async get(key) {
            const keyString = nodeIdentifierToString(key);
            if (dels.has(keyString)) {
                return undefined;
            }
            if (puts.has(keyString)) {
                return puts.get(keyString);
            }
            return await database.get(key);
        },
    };
}

/**
 * A seeding transaction: the batch a fixture writes through.
 *
 * The properties that this typedef carries are:
 * - Its commit goes to `SchemaStorage.batch` directly, so it is not a user
 *   operation and stages no Journal intent.
 * - Identifier allocations made through it become part of the committed
 *   identifier lookup when the commit succeeds.
 *
 * The proof of those properties is guaranteed by:
 * - This typedef cannot enforce the properties by construction.
 * - Therefore `withSeedingTransaction(graph, run)` is the only function that
 *   produces one, and it satisfies them because it builds its own operations
 *   array, issues exactly one `schemaStorage.batch(...)` containing the
 *   `identifiers_keys_map` and `last_node_index` global writes, and never
 *   calls `graph.storage.withTransaction` or `graph.storage.withUserOperation`.
 *
 * @typedef {object} SeedingTransaction
 * @property {{values: ReturnType<typeof makeSeededSublevelBatch>, freshness: ReturnType<typeof makeSeededSublevelBatch>, valid: ReturnType<typeof makeSeededSublevelBatch>, timestamps: ReturnType<typeof makeSeededSublevelBatch>}} batch
 * @property {import('../src/generators/incremental_graph/database/identifier_lookup').TransactionIdentifierLookup} identifierLookup
 */

/**
 * Run a fixture's graph writes as a seeding transaction.
 *
 * A fixture establishes a starting state; it is not a user-visible operation,
 * so it must not claim to be one. This path writes the graph sublevels and the
 * identifier table as one batch of the replica's own `SchemaStorage`, which is
 * the seam the graph's user-operation publication does not own.
 *
 * @template T
 * @param {import('../src/generators/incremental_graph').IncrementalGraph} graph
 * @param {(tx: SeedingTransaction) => Promise<T>} run
 * @returns {Promise<T>}
 */
async function withSeedingTransaction(graph, run) {
    const rootDatabase = graph.rootDatabase;
    const schemaStorage = rootDatabase.getSchemaStorage();
    const identifierLookup = makeTransactionIdentifierLookup(
        rootDatabase.getActiveIdentifierLookup()
    );
    /** @type {Array<object>} */
    const operations = [];
    /** @type {Map<string, NodeIdentifier[]>} */
    const seededValid = new Map();

    /** @type {SeedingTransaction["batch"]["valid"]} */
    const valid = {
        put(key, value) {
            const sorted = [...value].sort(compareNodeIdentifier);
            seededValid.set(nodeIdentifierToString(key), sorted);
            operations.push(schemaStorage.valid.putOp(key, sorted));
        },
        del(key) {
            seededValid.set(nodeIdentifierToString(key), []);
            operations.push(schemaStorage.valid.delOp(key));
        },
        async get(key) {
            const keyString = nodeIdentifierToString(key);
            const pending = seededValid.get(keyString);
            if (pending !== undefined) {
                return pending;
            }
            return await schemaStorage.valid.get(key);
        },
    };

    /** @type {SeedingTransaction} */
    const tx = {
        batch: {
            values: makeSeededSublevelBatch(schemaStorage.values, operations),
            freshness: makeSeededSublevelBatch(schemaStorage.freshness, operations),
            valid,
            timestamps: makeSeededSublevelBatch(schemaStorage.timestamps, operations),
        },
        identifierLookup,
    };

    try {
        const value = await run(tx);

        await graph.storage.withCommitSnapshot(async () => {
            const hasPendingAllocations = identifierLookup.keyToId.size > 0;
            if (operations.length === 0 && !hasPendingAllocations) {
                return;
            }
            /** @type {number | undefined} */
            let commitLastNodeIndex;
            if (hasPendingAllocations) {
                commitLastNodeIndex = rootDatabase.getCurrentAllocationWatermark();
                operations.push(
                    schemaStorage.global.putOp(
                        IDENTIFIERS_KEY,
                        serializeTransactionLookup(identifierLookup)
                    )
                );
                operations.push(
                    schemaStorage.global.putOp(LAST_NODE_INDEX_KEY, commitLastNodeIndex)
                );
            }
            await schemaStorage.batch(operations);
            if (commitLastNodeIndex !== undefined) {
                commitTransactionLookup(identifierLookup);
                rootDatabase.advanceLastNodeIndex(commitLastNodeIndex);
            }
        });

        return value;
    } finally {
        rootDatabase.releaseIdentifierReservations(identifierLookup.ownedKeys);
    }
}

/**
 * Create a semantic-key test storage facade on top of identifier-native graph storage.
 * This helper is only for tests that seed or inspect graph state directly.
 * @param {import('../src/generators/incremental_graph').IncrementalGraph} graph
 */
function makeSemanticStorage(graph) {
    /**
     * @param {"values" | "freshness" | "valid" | "timestamps"} databaseName
     */
    function makeDatabase(databaseName) {
        return {
            async get(key) {
                const jsonKey = toJsonKey(key);
                const nodeIdentifier = graph.rootDatabase.nodeKeyToId(jsonKey);
                if (nodeIdentifier === undefined) {
                    return undefined;
                }
                const value = await graph.storage[databaseName].get(nodeIdentifier);
                if (value === undefined) {
                    return undefined;
                }
                if (databaseName === "valid") {
                    return value.map((nodeIdentifierValue) => {
                        const nodeKey = graph.rootDatabase.nodeIdToKey(nodeIdentifierValue);
                        if (nodeKey === undefined) {
                            throw new Error(
                                `Missing semantic node key for valid identifier in get(): ${nodeIdentifierValue}`
                            );
                        }
                        return nodeKey;
                    });
                }
                return value;
            },
            async put(key, value) {
                const jsonKey = toJsonKey(key);
                await withSeedingTransaction(graph, async (tx) => {
                    const nodeIdentifier = allocateSeededIdentifier(
                        graph,
                        tx,
                        jsonKey
                    );
                    if (databaseName === "valid") {
                        tx.batch.valid.put(
                            nodeIdentifier,
                            value.map((dependentKey) =>
                                allocateSeededIdentifier(graph, tx, toJsonKey(dependentKey))
                            )
                        );
                        return;
                    }
                    tx.batch[databaseName].put(nodeIdentifier, value);
                });
            },
            async del(key) {
                const jsonKey = toJsonKey(key);
                await withSeedingTransaction(graph, async (tx) => {
                    const nodeIdentifier = lookupSeededIdentifier(tx, jsonKey);
                    if (nodeIdentifier === undefined) {
                        return;
                    }
                    tx.batch[databaseName].del(nodeIdentifier);
                });
            },
        };
    }

    return {
        values: makeDatabase("values"),
        freshness: makeDatabase("freshness"),
        valid: makeDatabase("valid"),
        timestamps: makeDatabase("timestamps"),
        async listValidDependents(input, batch) {
            return (await batch.valid.get(input)) ?? [];
        },
        async withBatch(run) {
            return await withSeedingTransaction(graph, async (tx) => {
                /**
                 * @param {"values" | "freshness" | "valid" | "timestamps"} databaseName
                 */
                function makeBatchDatabase(databaseName) {
                    return {
                        put(key, value) {
                            const jsonKey = toJsonKey(key);
                            const nodeIdentifier = allocateSeededIdentifier(graph, tx, jsonKey);
                            if (databaseName === "valid") {
                                tx.batch.valid.put(
                                    nodeIdentifier,
                                    value.map((dependentKey) =>
                                        allocateSeededIdentifier(graph, tx, toJsonKey(dependentKey))
                                    )
                                );
                                return;
                            }
                            tx.batch[databaseName].put(nodeIdentifier, value);
                        },
                        del(key) {
                            const jsonKey = toJsonKey(key);
                            const nodeIdentifier = lookupSeededIdentifier(tx, jsonKey);
                            if (nodeIdentifier === undefined) {
                                return;
                            }
                            tx.batch[databaseName].del(nodeIdentifier);
                        },
                        async get(key) {
                            const jsonKey = toJsonKey(key);
                            const nodeIdentifier = lookupSeededIdentifier(tx, jsonKey);
                            if (nodeIdentifier === undefined) {
                                return undefined;
                            }
                            const value = await tx.batch[databaseName].get(nodeIdentifier);
                            if (value === undefined) {
                                return undefined;
                            }
                            if (databaseName === "valid") {
                                return value.map((dependentIdentifier) =>
                                    requireSeededNodeKey(tx, dependentIdentifier)
                                );
                            }
                            return value;
                        },
                    };
                }

                const semanticBatch = {
                    values: makeBatchDatabase("values"),
                    freshness: makeBatchDatabase("freshness"),
                    valid: makeBatchDatabase("valid"),
                    timestamps: makeBatchDatabase("timestamps"),
                };
                return await run(semanticBatch);
            });
        },
    };
}

/**
 * Create a semantic-key test database interface.
 * @param {import('../src/generators/incremental_graph').IncrementalGraph} graph
 * @returns {{put: (key: string, value: any) => Promise<void>, del: (key: string) => Promise<void>}}
 */
function makeTestDatabase(graph) {
    const storage = makeSemanticStorage(graph);

    return {
        /**
         * Put a value. Automatically routes to values or freshness database based on type.
         * Automatically converts node names to JSON key format.
         * @param {string} key
         * @param {any} value
         */
        async put(key, value) {
            const jsonKey = toJsonKey(key);
            if (value === "up-to-date" || value === "potentially-outdated") {
                await storage.freshness.put(jsonKey, value);
                return;
            }
            await storage.withBatch(async (batch) => {
                batch.values.put(jsonKey, value);
                if (await batch.freshness.get(jsonKey) === undefined) {
                    batch.freshness.put(jsonKey, "potentially-outdated");
                }
                if (await batch.timestamps.get(jsonKey) === undefined) {
                    const nowIso = graph.datetime.now().toISOString();
                    batch.timestamps.put(jsonKey, { createdAt: nowIso, modifiedAt: nowIso });
                }
            });
        },

        /**
         * Delete a value. Tries both databases.
         * Automatically converts node names to JSON key format.
         * @param {string} key
         */
        async del(key) {
            const jsonKey = toJsonKey(key);
            try {
                await storage.values.del(jsonKey);
            } catch (e) {
                // Ignore if not found
            }
            try {
                await storage.freshness.del(jsonKey);
            } catch (e) {
                // Ignore if not found
            }
            try {
                await storage.timestamps.del(jsonKey);
            } catch (e) {
                // Ignore if not found
            }
        },
    };
}

/**
 * @param {string} key
 * @returns {string}
 */
function freshnessKey(key) {
    return key;
}

module.exports = {
    makeTestDatabase,
    freshnessKey,
    makeSemanticStorage,
    toJsonKey,
};
