/**
 * Invariant: Every identifier-map entry corresponds exactly to a
 * materialized node, and vice versa.
 *
 * The identifiers_keys_map (persisted as `r/<replica>/global/identifiers_keys_map`)
 * is the authoritative bijection between semantic node keys and opaque identifiers.
 * A node is "materialized" when it has a record in the `inputs` sublevel
 * (`r/<replica>/inputs/<identifier>`).
 *
 * In normal pull/commit operation every identifier that enters the map does
 * so atomically with an `ensureMaterialized` call that writes the corresponding
 * inputs record (both happen inside `withTransaction`). Conversely, every
 * materialized node must have a map entry—otherwise there is no way to
 * recover its semantic key from the identifier stored in the inputs sublevel.
 *
 * This file tests both directions of the invariant:
 *   1. Map → inputs: For every identifier in identifiers_keys_map, there is a
 *      corresponding entry in the inputs sublevel.
 *   2. Inputs → map: For every entry in the inputs sublevel, the identifier
 *      appears in identifiers_keys_map.
 */

/* eslint jest/expect-expect: ["error", { "assertFunctionNames": ["expect", "expectInvariant"] }] */

const { getRootDatabase, nodeIdentifierToString } = require("../src/generators/incremental_graph/database");
const {
    makeIncrementalGraph,
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
 * Collect all identifier strings from the inputs sublevel into a Set.
 * @param {import('../src/generators/incremental_graph/database').RootDatabase} db
 * @returns {Promise<Set<string>>}
 */
async function collectInputsIdentifiers(db) {
    const ids = new Set();
    const inputs = db.getSchemaStorage().inputs;
    for await (const nodeId of inputs.keys()) {
        ids.add(nodeIdentifierToString(nodeId));
    }
    return ids;
}

/**
 * Assert that every identifier in the map has a corresponding inputs entry
 * and every inputs entry has a corresponding map entry.
 * @param {import('../src/generators/incremental_graph/database').IdentifierLookup} lookup
 * @param {import('../src/generators/incremental_graph/database').RootDatabase} db
 */
async function expectInvariant(lookup, db) {
    const mapIds = collectMapIdentifiers(lookup);
    const inputsIds = await collectInputsIdentifiers(db);

    // Direction 1: every identifier in the map must be materialized.
    const mapWithoutInputs = new Set();
    for (const idStr of mapIds) {
        if (!inputsIds.has(idStr)) {
            mapWithoutInputs.add(idStr);
        }
    }
    expect(mapWithoutInputs).toEqual(new Set());

    // Direction 2: every materialized node must have a map entry.
    const inputsWithoutMap = new Set();
    for (const idStr of inputsIds) {
        if (!mapIds.has(idStr)) {
            inputsWithoutMap.add(idStr);
        }
    }
    expect(inputsWithoutMap).toEqual(new Set());
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
        graph = makeIncrementalGraph(capabilities, db, nodeDefs);
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
});
