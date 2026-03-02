/**
 * Persistence and restart tests for IncrementalGraph.
 * These tests verify that the persistent reverse-dependency index works correctly across restarts.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { getRootDatabase } = require("../src/generators/incremental_graph/database");
const {
    makeIncrementalGraph,
    makeUnchanged,
} = require("../src/generators/incremental_graph");
const { getMockedRootCapabilities } = require("./spies");
const { makeTestDatabase } = require("./test_database_helper");
const { stubLogger, stubEnvironment } = require("./stubs");

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

            const graph1 = makeIncrementalGraph(db, schemas);

            const testDb = makeTestDatabase(graph1);

            // Initial setup
            await graph1.invalidate("A");
            await testDb.put("B", { value: 100 });

            // Pull C to establish values
            const result1 = await graph1.pull("C");
            expect(result1.value).toBe(200);
            expect(computeCalls).toEqual(["B", "C"]);

            // All should be up-to-date
            expect(await graph1.debugGetFreshness("A")).toBe("up-to-date");
            expect(await graph1.debugGetFreshness("B")).toBe("up-to-date");
            expect(await graph1.debugGetFreshness("C")).toBe("up-to-date");

            // *** RESTART ***
            computeCalls.length = 0;
            const graph2 = makeIncrementalGraph(db, schemas);

            // Update A (which should invalidate B and C)
            cellA.value = { value: 20 };
            await graph2.invalidate("A");

            // B and C should be potentially-outdated
            expect(await graph2.debugGetFreshness("B")).toBe("potentially-outdated");
            expect(await graph2.debugGetFreshness("C")).toBe("potentially-outdated");

            // Pull C - B should return Unchanged and propagate up-to-date to C
            const result2 = await graph2.pull("C");
            expect(result2.value).toBe(200); // Same as before
            expect(computeCalls).toEqual(["B"]); // Only B computed, C was marked up-to-date via propagation

            // Both B and C should be up-to-date now
            expect(await graph2.debugGetFreshness("B")).toBe("up-to-date");
            expect(await graph2.debugGetFreshness("C")).toBe("up-to-date");

            await db.close();
        });
    });

    describe("Version-based namespacing", () => {
        test("dbVersion is the application version string", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const schemas = [
                {
                    output: "A",
                    inputs: [],
                    computor: () => ({ value: 1 }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeIncrementalGraph(db, schemas);
            const version = graph.debugGetDbVersion();

            // The version should be a non-empty string (the application version)
            expect(typeof version).toBe("string");
            expect(version.length).toBeGreaterThan(0);

            await db.close();
        });

        test("two graphs from the same database share the same dbVersion", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const schemas1 = [
                {
                    output: "A",
                    inputs: [],
                    computor: () => ({ value: 1 }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const schemas2 = [
                {
                    output: "A",
                    inputs: [],
                    computor: () => ({ value: 1 }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "B",
                    inputs: ["A"],
                    computor: (inputs) => ({ value: inputs[0].value * 2 }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph1 = makeIncrementalGraph(db, schemas1);
            const graph2 = makeIncrementalGraph(db, schemas2);

            // Both graphs use the same application version as namespace
            expect(graph1.debugGetDbVersion()).toBe(graph2.debugGetDbVersion());

            await db.close();
        });
    });

});
