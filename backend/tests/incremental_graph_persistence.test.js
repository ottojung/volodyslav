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
const { stubLogger } = require("./stubs");

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

describe("Incremental graph persistence and restart", () => {
    describe("Restart preserves downstream up-to-date propagation", () => {
        test("Unchanged propagation works after restart", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);
            const computeCalls = [];

            const cellA = { value: { value: 10 } };
            const shouldBReturnUnchanged = { value: false };

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
                        if (shouldBReturnUnchanged.value) {
                            return makeUnchanged();
                        }
                        return { value: 100 };
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

            // Initial setup - compute B which will set its value to 100
            await graph1.invalidate("A");

            // Pull C to establish values (this will compute B which returns 100, then C which doubles it)
            const result1 = await graph1.pull("C");
            expect(result1.value).toBe(200);
            expect(computeCalls).toEqual(["B", "C"]);

            // *** RESTART ***
            computeCalls.length = 0;
            const graph2 = makeIncrementalGraph(db, schemas);

            // Update A and enable Unchanged returns for B
            cellA.value = { value: 20 };
            shouldBReturnUnchanged.value = true;
            await graph2.invalidate("A");

            // Pull C - B should return Unchanged and propagate up-to-date to C
            const result2 = await graph2.pull("C");
            expect(result2.value).toBe(200); // Same as before
            expect(computeCalls).toEqual(["B"]); // Only B computed, C was marked up-to-date via propagation

            await db.close();
        });
    });

    describe("Schema hash namespacing", () => {
        test("different schemas use different namespaces", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const computeCalls1 = [];
            const computeCalls2 = [];

            const cellA1 = { value: { value: 0 } };
            const cellA2 = { value: { value: 0 } };

            // Schema 1: Simple A -> B chain
            const schemas1 = [
                {
                    output: "A",
                    inputs: [],
                    computor: () => {
                        computeCalls1.push("A");
                        return cellA1.value;
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "B",
                    inputs: ["A"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls1.push("B");
                        return { value: inputs[0].value * 2 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            // Schema 2: A -> B -> C chain (different structure)
            const schemas2 = [
                {
                    output: "A",
                    inputs: [],
                    computor: () => {
                        computeCalls2.push("A");
                        return cellA2.value;
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "B",
                    inputs: ["A"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls2.push("B");
                        return { value: inputs[0].value * 2 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "C",
                    inputs: ["B"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls2.push("C");
                        return { value: inputs[0].value + 1 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            // Create both graphs with different schemas
            const graph1 = makeIncrementalGraph(db, schemas1);
            const graph2 = makeIncrementalGraph(db, schemas2);

            // Set up initial values and compute
            cellA1.value = { value: 10 };
            cellA2.value = { value: 10 };
            await graph1.invalidate("A");
            await graph2.invalidate("A");

            const result1 = await graph1.pull("B");
            const result2 = await graph2.pull("C");

            // Verify both graphs computed independently
            expect(result1.value).toBe(20); // 10 * 2
            expect(result2.value).toBe(21); // (10 * 2) + 1
            expect(computeCalls1).toEqual(["A", "B"]);
            expect(computeCalls2).toEqual(["A", "B", "C"]);

            // Reset computation tracking
            computeCalls1.length = 0;
            computeCalls2.length = 0;

            // Invalidate A in graph1 only
            cellA1.value = { value: 20 };
            await graph1.invalidate("A");

            // Pull B from graph1, C from graph2
            const result1After = await graph1.pull("B");
            const result2After = await graph2.pull("C");

            // Verify graph1 recomputed but graph2 did not
            expect(result1After.value).toBe(40); // 20 * 2
            expect(result2After.value).toBe(21); // Still (10 * 2) + 1
            expect(computeCalls1).toEqual(["A", "B"]); // graph1 recomputed
            expect(computeCalls2).toEqual([]); // graph2 did not recompute

            await db.close();
        });
    });

});
