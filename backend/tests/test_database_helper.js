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
const {
    getOrAllocateNodeIdentifier,
    lookupNodeIdentifier,
    requireNodeKey,
} = require("../src/generators/incremental_graph/graph_state");

/**
 * Converts a node name to JSON key format if needed.
 * @param {string} key
 * @returns {string}
 */
/**
 * Allocate an identifier in a test transaction.
 * @param {import('../src/generators/incremental_graph/graph_state').Transaction} tx
 * @param {import('../src/generators/incremental_graph/database/root_database').RootDatabase} rootDatabase
 * @param {string} jsonKey
 * @returns {import('../src/generators/incremental_graph/database').NodeIdentifier}
 */
function getOrAllocateNodeIdentifierForTest(tx, rootDatabase, jsonKey) {
    return getOrAllocateNodeIdentifier(tx, rootDatabase, jsonKey);
}

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
                await graph.storage.withTransaction(async (tx) => {
                    const nodeIdentifier = getOrAllocateNodeIdentifierForTest(
                        tx,
                        graph.rootDatabase,
                        jsonKey
                    );
                    if (databaseName === "valid") {
                        tx.batch.valid.put(
                            nodeIdentifier,
                            value.map((dependentKey) =>
                                getOrAllocateNodeIdentifierForTest(
                                    tx,
                                    graph.rootDatabase,
                                    toJsonKey(dependentKey)
                                )
                            )
                        );
                        return { value: undefined };
                    }
                    tx.batch[databaseName].put(nodeIdentifier, value);
                    return { value: undefined };
                });
            },
            async del(key) {
                const jsonKey = toJsonKey(key);
                const nodeIdentifier = graph.rootDatabase.nodeKeyToId(jsonKey);
                if (nodeIdentifier === undefined) {
                    return;
                }
                await graph.storage.withTransaction(async (tx) => {
                    tx.batch[databaseName].del(nodeIdentifier);
                    return { value: undefined };
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
            return await graph.storage.withTransaction(async (tx) => {
                /**
                 * @param {"values" | "freshness" | "valid" | "timestamps"} databaseName
                 */
                function makeBatchDatabase(databaseName) {
                    return {
                        put(key, value) {
                            const jsonKey = toJsonKey(key);
                            const nodeIdentifier =
                                getOrAllocateNodeIdentifierForTest(tx, graph.rootDatabase, jsonKey);
                            if (databaseName === "valid") {
                                tx.batch.valid.put(
                                    nodeIdentifier,
                                    value.map((dependentKey) =>
                                        getOrAllocateNodeIdentifierForTest(
                                            tx,
                                            graph.rootDatabase,
                                            toJsonKey(dependentKey)
                                        )
                                    )
                                );
                                return;
                            }
                            tx.batch[databaseName].put(nodeIdentifier, value);
                        },
                        del(key) {
                            const jsonKey = toJsonKey(key);
                            const nodeIdentifier =
                                lookupNodeIdentifier(tx, jsonKey);
                            if (nodeIdentifier === undefined) {
                                return;
                            }
                            tx.batch[databaseName].del(nodeIdentifier);
                        },
                        async get(key) {
                            const jsonKey = toJsonKey(key);
                            const nodeIdentifier =
                                lookupNodeIdentifier(tx, jsonKey);
                            if (nodeIdentifier === undefined) {
                                return undefined;
                            }
                            const value = await tx.batch[databaseName].get(nodeIdentifier);
                            if (value === undefined) {
                                return undefined;
                            }
                            if (databaseName === "valid") {
                                return value.map((dependentIdentifier) =>
                                    requireNodeKey(tx, dependentIdentifier)
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
                const runResult = await run(semanticBatch);
                return { value: runResult };
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
