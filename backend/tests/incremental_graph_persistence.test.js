/**
 * Persistence and restart tests for IncrementalGraph.
 * These tests verify that the persistent validity index works correctly across restarts.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { getRootDatabase, IDENTIFIERS_KEY } = require("../src/generators/incremental_graph/database");
const {
    createIncrementalGraph,
    makeUnchanged,
} = require("../src/generators/incremental_graph");
const { getMockedRootCapabilities } = require("./spies");
const { makeSemanticStorage, makeTestDatabase } = require("./test_database_helper");
const { stubLogger, stubEnvironment } = require("./stubs");
const { toJsonKey } = require("./test_json_key_helper");

/**
 * Creates test capabilities with a temporary data directory.
 */
function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "graph-persistence-test-")
    );

    stubLogger(capabilities);
    stubEnvironment(capabilities);
    return { ...capabilities, tmpDir };
}

/**
 * @param {import('../src/generators/incremental_graph').IncrementalGraph} graph
 * @returns {Promise<unknown>}
 */
async function getPersistedIdentifiersKeysMap(graph) {
    return await graph.rootDatabase.getSchemaStorage().global.get(IDENTIFIERS_KEY);
}

describe("Incremental graph persistence and restart", () => {
    describe("Restart preserves downstream up-to-date propagation", () => {
        test("Unchanged propagation works after restart", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);
            const computeCalls = [];

            const cellA = { value: { value: 10 } };

            const schemas = [
                {
                    output: "A",
                    inputs: [],
                    computor: () => cellA.value,
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "B",
                    inputs: ["A"],
                    computor: (_inputs, _oldValue, _bindings) => {
                        computeCalls.push("B");
                        // Always return Unchanged to test propagation
                        return makeUnchanged();
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "C",
                    inputs: ["B"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("C");
                        return { value: inputs[0].value * 2 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph1 = await createIncrementalGraph(capabilities, db, schemas);

            const testDb = makeTestDatabase(graph1);

            // Initial setup
            await graph1.invalidate("A");
            await testDb.put("B", { value: 100 });

            // Pull C to establish values
            const result1 = await graph1.pull("C");
            expect(result1.value).toBe(200);
            expect(computeCalls).toEqual(["B", "C"]);

            // All should be up-to-date
            expect(await graph1.getFreshness("A")).toBe("up-to-date");
            expect(await graph1.getFreshness("B")).toBe("up-to-date");
            expect(await graph1.getFreshness("C")).toBe("up-to-date");

            // *** RESTART ***
            computeCalls.length = 0;
            const graph2 = await createIncrementalGraph(capabilities, db, schemas);

            // Update A (which should invalidate B and C)
            cellA.value = { value: 20 };
            await graph2.invalidate("A");

            // B and C should be potentially-outdated
            expect(await graph2.getFreshness("B")).toBe("potentially-outdated");
            expect(await graph2.getFreshness("C")).toBe("potentially-outdated");

            // Pull C - B should return Unchanged and propagate up-to-date to C
            const result2 = await graph2.pull("C");
            expect(result2.value).toBe(200); // Same as before
            expect(computeCalls).toEqual(["B"]); // Only B computed, C was marked up-to-date via propagation

            // Both B and C should be up-to-date now
            expect(await graph2.getFreshness("B")).toBe("up-to-date");
            expect(await graph2.getFreshness("C")).toBe("up-to-date");

            await db.close();
        });
    });

    describe("Version namespacing", () => {
        test("graphs with the same database use the same dbVersion", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const cellA = { value: { value: 0 } };

            // Both graphs must use the same full schema because
            // global/graph_scheme is immutable initialization metadata.
            // graph1 just happens to only pull A.
            const fullSchemas = [
                {
                    output: "A",
                    inputs: [],
                    computor: () => cellA.value,
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "B",
                    inputs: ["A"],
                    computor: (inputs, _oldValue, _bindings) => ({
                        value: inputs[0].value * 2,
                    }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            // Create graph with the full schema
            const graph1 = await createIncrementalGraph(capabilities, db, fullSchemas);
            const version1 = graph1.getDbVersion();

            cellA.value = { value: 10 };
            await graph1.invalidate("A");

            // Create another graph with the same full schema.
            // The stored graph_scheme matches exactly, so this succeeds.
            const graph2 = await createIncrementalGraph(capabilities, db, fullSchemas);
            const version2 = graph2.getDbVersion();

            // Both graphs use the same dbVersion since they share the same database
            expect(version1).toBe(version2);

            // Pull B with graph2
            await graph2.pull("B");

            // Verify that schema2 can list dependents properly
            const storage2 = makeSemanticStorage(graph2);
            let dependents2;
            await storage2.withBatch(async (batch) => {
                dependents2 = await storage2.listValidDependents(toJsonKey("A"), batch);
            });
            expect(dependents2).toContain(toJsonKey("B"));

            await db.close();
        });
    });

    describe("Invalidate does not materialize unmaterialized nodes", () => {
        test("invalidate on a never-pulled node is a no-op and stays unmaterialized after reopen", async () => {
            const capabilities = getTestCapabilities();
            const db1 = await getRootDatabase(capabilities);
            const schemas = [
                {
                    output: "source",
                    inputs: [],
                    computor: async () => ({ value: 1 }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];
            const graph1 = await createIncrementalGraph(capabilities, db1, schemas);

            const before = await getPersistedIdentifiersKeysMap(graph1);

            await graph1.invalidate("source");

            expect(await graph1.getFreshness("source")).toBe("unmaterialized");
            expect(await graph1.listMaterializedNodes()).toEqual([]);
            expect(await getPersistedIdentifiersKeysMap(graph1)).toEqual(before);

            await db1.close();

            const db2 = await getRootDatabase(capabilities);
            const graph2 = await createIncrementalGraph(capabilities, db2, schemas);

            expect(await graph2.getFreshness("source")).toBe("unmaterialized");
            expect(await graph2.listMaterializedNodes()).toEqual([]);
            expect(await getPersistedIdentifiersKeysMap(graph2)).toEqual(before);

            await db2.close();
        });

        test("invalidate on a never-materialized dependent does not materialize its inputs", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);
            const graph = await createIncrementalGraph(capabilities, db, [
                {
                    output: "source",
                    inputs: [],
                    computor: async () => ({ value: 1 }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "derived",
                    inputs: ["source"],
                    computor: async ([source]) => ({ value: source.value + 1 }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ]);

            await graph.invalidate("derived");

            expect(await graph.getFreshness("source")).toBe("unmaterialized");
            expect(await graph.getFreshness("derived")).toBe("unmaterialized");
            expect(await graph.listMaterializedNodes()).toEqual([]);

            await db.close();
        });

        test("invalidate on a materialized source preserves materialization and propagates freshness", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);
            const graph = await createIncrementalGraph(capabilities, db, [
                {
                    output: "source",
                    inputs: [],
                    computor: async () => ({ value: 1 }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "derived",
                    inputs: ["source"],
                    computor: async ([source]) => ({ value: source.value + 1 }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ]);

            await graph.pull("derived");
            const before = await graph.listMaterializedNodes();

            await graph.invalidate("source");

            expect(await graph.getFreshness("source")).toBe("potentially-outdated");
            expect(await graph.getFreshness("derived")).toBe("potentially-outdated");
            expect(await graph.listMaterializedNodes()).toEqual(before);

            await db.close();
        });
    });

});
