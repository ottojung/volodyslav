/**
 * Test helper to create a compatibility database interface.
 * This helps tests transition from old db.put() pattern to new storage pattern.
 *
 * Usage:
 *   const db = await getRootDatabase(capabilities);
 *   const graphDef = [..];
 *   const graph = makeIncrementalGraph(db, graphDef);
 *   const testDb = makeTestDatabase(graph);
 *
 *   // Now use old pattern:
 *   await testDb.put("key", value);  // stores to storage.values
 *   await testDb.put("key", "up-to-date");  // stores to storage.freshness
 */

const {
    createNodeKeyFromPattern,
    serializeNodeKey,
} = require("../src/generators/incremental_graph/database/node_key");
const {
    nodeIdentifierFromString,
    nodeIdentifierToString,
} = require("../src/generators/incremental_graph/database");
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
     * @param {string[]} sortedArray
     * @param {string} value
     * @returns {{ index: number, found: boolean }}
     */
    function findInsertionIndex(sortedArray, value) {
        let lo = 0;
        let hi = sortedArray.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            const current = sortedArray[mid];
            if (current === undefined) {
                throw new Error(`Missing value at index ${String(mid)}`);
            }
            if (current === value) {
                return { index: mid, found: true };
            }
            if (current < value) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        return { index: lo, found: false };
    }

    /**
     * @param {"values" | "freshness" | "inputs" | "revdeps" | "counters" | "timestamps"} databaseName
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
                if (databaseName === "inputs") {
                    return {
                        inputs: value.inputs.map((inputIdentifier) => {
                            const nodeKey = graph.rootDatabase.nodeIdToKey(
                                nodeIdentifierFromString(inputIdentifier)
                            );
                            if (nodeKey === undefined) {
                                throw new Error(
                                    `Missing semantic node key for input identifier ${String(inputIdentifier)} in get() for parent key ${String(key)} (json key ${String(jsonKey)})`
                                );
                            }
                            return String(nodeKey);
                        }),
                        inputCounters: value.inputCounters,
                    };
                }
                if (databaseName === "revdeps") {
                    return value.map((nodeIdentifierValue) => {
                        const nodeKey = graph.rootDatabase.nodeIdToKey(nodeIdentifierValue);
                        if (nodeKey === undefined) {
                            throw new Error(
                                `Missing semantic node key for revdep identifier in get(): ${nodeIdentifierValue}`
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
                    if (databaseName === "inputs") {
                        tx.batch.inputs.put(nodeIdentifier, {
                            inputs: value.inputs.map((inputKey) =>
                                nodeIdentifierToString(
                                    getOrAllocateNodeIdentifierForTest(
                                        tx,
                                        graph.rootDatabase,
                                        toJsonKey(inputKey)
                                    )
                                )
                            ),
                            inputCounters: value.inputCounters,
                        });
                        return { value: undefined, revdepDiffs: [] };
                    }
                    if (databaseName === "revdeps") {
                        tx.batch.revdeps.put(
                            nodeIdentifier,
                            value.map((dependentKey) =>
                                getOrAllocateNodeIdentifierForTest(
                                    tx,
                                    graph.rootDatabase,
                                    toJsonKey(dependentKey)
                                )
                            )
                        );
                        return { value: undefined, revdepDiffs: [] };
                    }
                    tx.batch[databaseName].put(nodeIdentifier, value);
                    return { value: undefined, revdepDiffs: [] };
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
                    return { value: undefined, revdepDiffs: [] };
                });
            },
        };
    }

    return {
        values: makeDatabase("values"),
        freshness: makeDatabase("freshness"),
        inputs: makeDatabase("inputs"),
        revdeps: makeDatabase("revdeps"),
        counters: makeDatabase("counters"),
        timestamps: makeDatabase("timestamps"),
        async ensureMaterialized(node, inputs, inputCounters, batch) {
            batch.inputs.put(node, { inputs, inputCounters });
        },
        async ensureReverseDepsIndexed(node, inputs, batch) {
            for (const input of inputs) {
                const existingDependents = (await batch.revdeps.get(input)) ?? [];
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
        },
        async listDependents(input, batch) {
            return (await batch.revdeps.get(input)) ?? [];
        },
        async getInputs(node, batch) {
            const record = await batch.inputs.get(node);
            return record ? record.inputs : null;
        },
        async withBatch(run) {
            return await graph.storage.withTransaction(async (tx) => {
                /**
                 * @param {"values" | "freshness" | "inputs" | "revdeps" | "counters" | "timestamps"} databaseName
                 */
                function makeBatchDatabase(databaseName) {
                    return {
                        put(key, value) {
                            const jsonKey = toJsonKey(key);
                            const nodeIdentifier =
                                getOrAllocateNodeIdentifierForTest(tx, graph.rootDatabase, jsonKey);
                            if (databaseName === "inputs") {
                                tx.batch.inputs.put(nodeIdentifier, {
                                    inputs: value.inputs.map((inputKey) =>
                                        nodeIdentifierToString(
                                            getOrAllocateNodeIdentifierForTest(
                                                tx,
                                                graph.rootDatabase,
                                                toJsonKey(inputKey)
                                            )
                                        )
                                    ),
                                    inputCounters: value.inputCounters,
                                });
                                return;
                            }
                            if (databaseName === "revdeps") {
                                tx.batch.revdeps.put(
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
                            if (databaseName === "inputs") {
                                return {
                                    inputs: value.inputs.map((inputIdentifier) =>
                                        String(
                                            requireNodeKey(
                                                tx,
                                                nodeIdentifierFromString(inputIdentifier)
                                            )
                                        )
                                    ),
                                    inputCounters: value.inputCounters,
                                };
                            }
                            if (databaseName === "revdeps") {
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
                    inputs: makeBatchDatabase("inputs"),
                    revdeps: makeBatchDatabase("revdeps"),
                    counters: makeBatchDatabase("counters"),
                    timestamps: makeBatchDatabase("timestamps"),
                };
                const runResult = await run(semanticBatch);
                return { value: runResult, revdepDiffs: [] };
            });
        },
    };
}

/**
 * Create a test database interface that mimics the old Database class.
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
            } else {
                await storage.values.put(jsonKey, value);
            }
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
        },
    };
}

/**
 * freshnessKey is no longer needed with the new design.
 * This function now just returns the key unchanged.
 * Tests using freshnessKey("key") will pass "key" to put() with a Freshness value,
 * which makeTestDatabase() will correctly route to the freshness database.
 * @param {string} key
 * @returns {string}
 * @deprecated Use storage.freshness.put() directly instead
 */
function freshnessKey(key) {
    return key;
}

module.exports = {
    makeSemanticStorage,
    makeTestDatabase,
    freshnessKey,
};
