/**
 * Persistence and restart tests for DependencyGraph.
 * These tests verify that the persistent reverse-dependency index works correctly across restarts.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { getRootDatabase } = require("../src/generators/dependency_graph/database");
const {
    makeDependencyGraph,
    makeUnchanged,
} = require("../src/generators/dependency_graph");
const { getMockedRootCapabilities } = require("./spies");
const { makeTestDatabase } = require("./test_database_helper");
const { stubLogger } = require("./stubs");
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

    capabilities.environment = {
        pathToVolodyslavDataDirectory: jest.fn().mockReturnValue(tmpDir),
    };

    return { ...capabilities, tmpDir };
}

describe("Dependency graph persistence and restart", () => {
    describe("Restart preserves downstream up-to-date propagation", () => {
        test("Unchanged propagation works after restart", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);
            const computeCalls = [];

            const schemas = [
                {
                    output: "A",
                    inputs: [],
                    computor: (_inputs, oldValue, _bindings) => oldValue,
                },
                {
                    output: "B",
                    inputs: ["A"],
                    computor: (_inputs, _oldValue, _bindings) => {
                        computeCalls.push("B");
                        // Always return Unchanged to test propagation
                        return makeUnchanged();
                    },
                },
                {
                    output: "C",
                    inputs: ["B"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("C");
                        return { value: inputs[0].value * 2 };
                    },
                },
            ];

            const graph1 = makeDependencyGraph(db, schemas);

            const testDb = makeTestDatabase(graph1);

            // Initial setup
            await testDb.put("A", { value: 10 });
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
            const graph2 = makeDependencyGraph(db, schemas);

            // Update A (which should invalidate B and C)
            await graph2.set("A", { value: 20 });

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

    describe("Schema hash namespacing", () => {
        test("different schemas use different namespaces", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const schemas1 = [
                {
                    output: "A",
                    inputs: [],
                    computor: (_inputs, oldValue, _bindings) => oldValue || { value: 0 },
                },
            ];

            const schemas2 = [
                {
                    output: "A",
                    inputs: [],
                    computor: (_inputs, oldValue, _bindings) => oldValue || { value: 0 },
                },
                {
                    output: "B",
                    inputs: ["A"],
                    computor: (inputs, _oldValue, _bindings) => ({
                        value: inputs[0].value * 2,
                    }),
                },
            ];

            // Create graph with schema1
            const graph1 = makeDependencyGraph(db, schemas1);
            const hash1 = graph1.schemaHash;

            const testDb = makeTestDatabase(graph1);

            await testDb.put("A", { value: 10 });

            // Create graph with schema2 (different schema)
            const graph2 = makeDependencyGraph(db, schemas2);
            const hash2 = graph2.schemaHash;

            // Different schemas should have different hashes
            expect(hash1).not.toBe(hash2);

            // Pull B with schema2
            await graph2.pull("B");

            // Verify that schema2 can list dependents properly
            const storage2 = graph2.getStorage();
            const dependents2 = await storage2.listDependents(toJsonKey("A"));
            expect(dependents2).toContain(toJsonKey("B"));

            // Verify schema1's namespace is separate (no B in schema1)
            const storage1 = graph1.getStorage();
            const dependents1 = await storage1.listDependents(toJsonKey("A"));
            expect(dependents1).not.toContain(toJsonKey("B")); // schema1 doesn't have B node

            await db.close();
        });
    });

});
