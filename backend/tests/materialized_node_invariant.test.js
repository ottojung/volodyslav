/**
 * Invariant: Every identifier-map entry corresponds exactly to a
 * materialized node, and materialized nodes are dependency-closed.
 *
 * The identifiers_keys_map (persisted as `r/<replica>/global/identifiers_keys_map`)
 * is the authoritative bijection between semantic node keys and deterministic identifiers.
 * A node is "materialized" when it has a record in the `values` sublevel
 * (`r/<replica>/values/<identifier>`).
 *
 * In normal pull/commit operation every identifier that enters the map does
 * so atomically with a write to the values sublevel (both happen inside
 * `withTransaction`). Conversely, every materialized node must have a map
 * entry—otherwise there is no way to recover its semantic key from the
 * identifier stored in the values sublevel.
 *
 * This file tests both record-domain equality and dependency closure: every
 * materialized node has every concrete input materialized.
 */

/* eslint jest/expect-expect: ["error", { "assertFunctionNames": ["expect", "expectInvariant"] }] */

const { getRootDatabase, nodeIdentifierToString, isReplicaStateInvariantError, assertValidReplicaMaterializationState } = require("../src/generators/incremental_graph/database");
const {
    createIncrementalGraph,
} = require("../src/generators/incremental_graph");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger, stubEnvironment } = require("./stubs");

/** @typedef {import('../src/generators/incremental_graph/database/types').DatabaseCapabilities} DatabaseCapabilities */

/**
 * Creates test capabilities with a temporary data directory.
 * @returns {DatabaseCapabilities & { tmpDir: string }}
 */
function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    return capabilities;
}

/**
 * Collect all identifier strings from the identifier lookup into a Set.
 * @param {import('../src/generators/incremental_graph/database').IdentifierLookup} lookup
 * @returns {Set<string>}
 */
function collectMapIdentifiers(lookup) {
    const ids = new Set();
    for (const idStr of lookup.idToKey.keys()) {
        ids.add(idStr);
    }
    return ids;
}

/**
 * Collect all identifier strings from the values sublevel into a Set.
 * @param {import('../src/generators/incremental_graph/database').RootDatabase} db
 * @returns {Promise<Set<string>>}
 */
async function collectValuesIdentifiers(db) {
    const ids = new Set();
    const values = db.getSchemaStorage().values;
    for await (const nodeId of values.keys()) {
        ids.add(nodeIdentifierToString(nodeId));
    }
    return ids;
}

/**
 * Assert that every identifier in the map has a corresponding values entry
 * and every values entry has a corresponding map entry.
 * @param {import('../src/generators/incremental_graph/database').IdentifierLookup} lookup
 * @param {import('../src/generators/incremental_graph/database').RootDatabase} db
 */
async function expectInvariant(lookup, db) {
    const mapIds = collectMapIdentifiers(lookup);
    const valuesIds = await collectValuesIdentifiers(db);

    // Direction 1: every identifier in the map must have a stored value.
    const mapWithoutValues = new Set();
    for (const idStr of mapIds) {
        if (!valuesIds.has(idStr)) {
            mapWithoutValues.add(idStr);
        }
    }
    expect(mapWithoutValues).toEqual(new Set());

    // Direction 2: every node with a stored value must have a map entry.
    const valuesWithoutMap = new Set();
    for (const idStr of valuesIds) {
        if (!mapIds.has(idStr)) {
            valuesWithoutMap.add(idStr);
        }
    }
    expect(valuesWithoutMap).toEqual(new Set());

    await assertValidReplicaMaterializationState(db.getSchemaStorage(), lookup, "materialized node invariant test");
}

describe("materialized node invariant", () => {
    /** @type {import('../src/generators/incremental_graph/database').RootDatabase} */
    let db;
    /** @type {import('../src/generators/incremental_graph').IncrementalGraph} */
    let graph;

    /**
     * Build a fresh graph with the given node definitions.
     * @param {Array<*>} nodeDefs
     */
    async function buildGraph(nodeDefs) {
        const capabilities = getTestCapabilities();
        db = await getRootDatabase(capabilities);
        graph = await createIncrementalGraph(capabilities, db, nodeDefs);
    }

    async function closeDb() {
        if (db) await db.close();
    }

    afterEach(async () => {
        await closeDb();
    });

    test("invariant holds after pulling a single node with no inputs", async () => {
        await buildGraph([
            {
                output: "standalone",
                inputs: [],
                computor: async () => ({ type: "test", value: 1 }),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ]);

        await graph.pull("standalone");
        await expectInvariant(db.getActiveIdentifierLookup(), db);
    });

    test("invariant holds after pulling a chain of dependent nodes", async () => {
        await buildGraph([
            {
                output: "source",
                inputs: [],
                computor: async () => ({ type: "test", value: 1 }),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "derived",
                inputs: ["source"],
                computor: async ([s]) => ({ type: "test", value: s.value + 1 }),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ]);

        // Pull only the leaf — the engine must also pull and materialize
        // the dependency "source".
        await graph.pull("derived");
        await expectInvariant(db.getActiveIdentifierLookup(), db);
    });

    test("invariant holds after sequential pulls of multiple independent nodes", async () => {
        await buildGraph([
            {
                output: "nodeA",
                inputs: [],
                computor: async () => ({ type: "test", value: 10 }),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "nodeB",
                inputs: [],
                computor: async () => ({ type: "test", value: 20 }),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "nodeC",
                inputs: [],
                computor: async () => ({ type: "test", value: 30 }),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ]);

        await graph.pull("nodeA");
        await graph.pull("nodeB");
        await graph.pull("nodeC");
        await expectInvariant(db.getActiveIdentifierLookup(), db);
    });

    test("invariant holds on re-pull of an already-materialized node", async () => {
        await buildGraph([
            {
                output: "steady",
                inputs: [],
                computor: async () => ({ type: "test", value: 99 }),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ]);

        // First pull — materializes the node and allocates an identifier.
        await graph.pull("steady");
        await expectInvariant(db.getActiveIdentifierLookup(), db);

        // Second pull — should return the cached value without allocating
        // a new identifier or changing the invariant.
        await graph.pull("steady");
        await expectInvariant(db.getActiveIdentifierLookup(), db);
    });

    test("invariant holds after invalidation and re-pull", async () => {
        await buildGraph([
            {
                output: "counter",
                inputs: [],
                computor: async () => ({ type: "test", value: Math.random() }),
                isDeterministic: false,
                hasSideEffects: false,
            },
        ]);

        await graph.pull("counter");
        await expectInvariant(db.getActiveIdentifierLookup(), db);

        // Invalidation marks the node potentially-outdated without
        // removing data — the invariant should still hold.
        await graph.invalidate("counter");
        await expectInvariant(db.getActiveIdentifierLookup(), db);

        // Re-pull after invalidation recomputes the value.
        await graph.pull("counter");
        await expectInvariant(db.getActiveIdentifierLookup(), db);
    });
    test("active replica preparation rejects an identifier without a cached value", async () => {
        const nodeDefs = [
            {
                output: "hollow",
                inputs: [],
                computor: async () => ({ type: "test", value: 7 }),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ];
        await buildGraph(nodeDefs);
        await graph.pull("hollow");

        const identifier = db.getActiveIdentifierLookup().keyToId.values().next().value;
        await db.getSchemaStorage().values.del(identifier);

        let caught;
        try {
            await createIncrementalGraph(getTestCapabilities(), db, nodeDefs);
        } catch (error) {
            caught = error;
        }
        expect(isReplicaStateInvariantError(caught)).toBe(true);
        expect(String(caught?.message)).toContain("active replica");
        expect(String(caught?.message)).toContain("has no cached value");
    });


    test("invalidate reads no cached value or timestamps for an existing node", async () => {
        await buildGraph([
            {
                output: "source",
                inputs: [],
                computor: async () => ({ type: "test", value: 1 }),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ]);

        await graph.pull("source");
        const storage = db.getSchemaStorage();
        const valueGet = jest.spyOn(storage.values, "get");
        const timestampGet = jest.spyOn(storage.timestamps, "get");

        await graph.invalidate("source");

        expect(valueGet).not.toHaveBeenCalled();
        expect(timestampGet).not.toHaveBeenCalled();
    });

    test("invalidate of an unmaterialized node writes no materialization records", async () => {
        await buildGraph([
            {
                output: "source",
                inputs: [],
                computor: async () => ({ type: "test", value: 1 }),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ]);

        const storage = db.getSchemaStorage();
        const valuePut = jest.spyOn(storage.values, "putOp");
        const freshnessPut = jest.spyOn(storage.freshness, "putOp");
        const timestampPut = jest.spyOn(storage.timestamps, "putOp");
        const beforeIds = [...db.getActiveIdentifierLookup().idToKey.keys()];

        await graph.invalidate("source");

        expect([...db.getActiveIdentifierLookup().idToKey.keys()]).toEqual(beforeIds);
        expect(valuePut).not.toHaveBeenCalled();
        expect(freshnessPut).not.toHaveBeenCalled();
        expect(timestampPut).not.toHaveBeenCalled();
    });

    test("getFreshness reads only lookup and freshness", async () => {
        await buildGraph([
            {
                output: "source",
                inputs: [],
                computor: async () => ({ type: "test", value: 1 }),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ]);

        await graph.pull("source");
        const storage = db.getSchemaStorage();
        const valueGet = jest.spyOn(storage.values, "get");
        const timestampGet = jest.spyOn(storage.timestamps, "get");
        const validGet = jest.spyOn(storage.valid, "get");

        await expect(graph.getFreshness("source")).resolves.toBe("up-to-date");

        expect(valueGet).not.toHaveBeenCalled();
        expect(timestampGet).not.toHaveBeenCalled();
        expect(validGet).not.toHaveBeenCalled();
    });

    test("getValue reads only lookup and cached value", async () => {
        await buildGraph([
            {
                output: "source",
                inputs: [],
                computor: async () => ({ type: "test", value: 1 }),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ]);

        await graph.pull("source");
        const storage = db.getSchemaStorage();
        const freshnessGet = jest.spyOn(storage.freshness, "get");
        const timestampGet = jest.spyOn(storage.timestamps, "get");
        const validGet = jest.spyOn(storage.valid, "get");

        await expect(graph.getValue("source")).resolves.toEqual({ type: "test", value: 1 });

        expect(freshnessGet).not.toHaveBeenCalled();
        expect(timestampGet).not.toHaveBeenCalled();
        expect(validGet).not.toHaveBeenCalled();
    });

});
