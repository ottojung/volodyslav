/**
 * Tests for generators/incremental_graph module.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { getRootDatabase } = require("../src/generators/incremental_graph/database");
const {
    makeIncrementalGraph,
    isIncrementalGraph,
    makeUnchanged,
} = require("../src/generators/incremental_graph");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger } = require("./stubs");

/**
 * @typedef {import('../src/generators/incremental_graph/database/types').DatabaseCapabilities} DatabaseCapabilities
 */

/**
 * Creates test capabilities with a temporary data directory.
 * @returns {DatabaseCapabilities & { tmpDir: string }}
 */
function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "incremental-graph-test-")
    );

    stubLogger(capabilities);

    // Override environment to use temp directory
    capabilities.environment = {
        pathToVolodyslavDataDirectory: jest.fn().mockReturnValue(tmpDir),
    };

    return { ...capabilities, tmpDir };
}

describe("generators/incremental_graph", () => {
    describe("makeIncrementalGraph()", () => {
        test("creates and returns a incremental graph instance", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);
            const graph = makeIncrementalGraph(db, []);

            expect(isIncrementalGraph(graph)).toBe(true);

            await db.close();
        });
    });

    describe("pull()", () => {
        test("lazily evaluates only necessary nodes", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const computeCalls = [];

            const input1Cell = { value: { type: 'all_events', events: [] } };

            const graphDef = [
                {
                    output: "input1",
                    inputs: [],
                    computor: () => input1Cell.value,
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "level1",
                    inputs: ["input1"],
                    computor: (_inputs, _oldValue, _bindings) => {
                        computeCalls.push("level1");
                        return { type: 'meta_events', meta_events: [] };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "level2",
                    inputs: ["level1"],
                    computor: (_inputs, _oldValue, _bindings) => {
                        computeCalls.push("level2");
                        return { type: 'meta_events', meta_events: [] };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "level3",
                    inputs: ["level2"],
                    computor: (_inputs, _oldValue, _bindings) => {
                        computeCalls.push("level3");
                        return { type: 'meta_events', meta_events: [] };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeIncrementalGraph(db, graphDef);

            input1Cell.value = { type: 'all_events', events: [] };
            await graph.invalidate("input1");

            const result = await graph.pull("level2");

            expect(result).toBeDefined();
            expect(computeCalls).toEqual(["level1", "level2"]);

            await db.close();
        });

        test("returns cached value when dependencies are clean", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            let computeCount = 0;

            const input1Cell = { value: { type: 'all_events', events: [] } };

            const graphDef = [
                {
                    output: "input1",
                    inputs: [],
                    computor: () => input1Cell.value,
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "output1",
                    inputs: ["input1"],
                    computor: (_inputs, _oldValue, _bindings) => {
                        computeCount++;
                        return { type: 'meta_events', meta_events: [] };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeIncrementalGraph(db, graphDef);

            input1Cell.value = { type: 'all_events', events: [] };
            await graph.invalidate("input1");

            const result1 = await graph.pull("output1");
            expect(result1.type).toBe("meta_events");
            expect(computeCount).toBe(1);

            const result2 = await graph.pull("output1");
            expect(result2.type).toBe("meta_events");
            expect(computeCount).toBe(1);

            await db.close();
        });

        test("recomputes when dependencies are dirty", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            let computeCount = 0;

            const input1Cell = { value: { data: "initial_data" } };

            const graphDef = [
                {
                    output: "input1",
                    inputs: [],
                    computor: () => input1Cell.value,
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "output1",
                    inputs: ["input1"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCount++;
                        return { data: inputs[0].data + "_processed" };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeIncrementalGraph(db, graphDef);

            input1Cell.value = { data: "new_data" };
            await graph.invalidate("input1");

            const result = await graph.pull("output1");

            expect(result.data).toBe("new_data_processed");
            expect(computeCount).toBe(1);

            const result2 = await graph.pull("output1");
            expect(result2.data).toBe("new_data_processed");
            expect(computeCount).toBe(1);

            await db.close();
        });

        test("throws error when pulling non-graph nodes", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const graph = makeIncrementalGraph(db, []);

            await expect(graph.pull("standalone")).rejects.toThrow(
                "not found in the incremental graph."
            );

            await expect(graph.pull("standalone")).rejects.toThrow(
                /not found in the incremental graph./
            );

            await db.close();
        });

        test("handles Unchanged return value", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            let computeCount = 0;

            const input1Cell = { value: { data: "test" } };

            const graphDef = [
                {
                    output: "input1",
                    inputs: [],
                    computor: () => input1Cell.value,
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "output1",
                    inputs: ["input1"],
                    computor: (_inputs, oldValue) => {
                        computeCount++;
                        if (!oldValue) {
                            return { data: "initial_value" };
                        }
                        return makeUnchanged();
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeIncrementalGraph(db, graphDef);

            input1Cell.value = { data: "test" };
            await graph.invalidate("input1");
            
            const result1 = await graph.pull("output1");
            expect(result1.data).toBe("initial_value");
            expect(computeCount).toBe(1);

            input1Cell.value = { data: "test2" };
            await graph.invalidate("input1");
            
            const result2 = await graph.pull("output1");
            expect(result2.data).toBe("initial_value");
            expect(computeCount).toBe(2);

            await db.close();
        });

        test("handles potentially-dirty propagation in linear chain", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const computeCalls = [];

            const graphDef = [
                {
                    output: "input1",
                    inputs: [],
                    computor: (inputs, oldValue, _bindings) => oldValue || { count: 1 },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "level1",
                    inputs: ["input1"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("level1");
                        return { count: inputs[0].count + 1 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "level2",
                    inputs: ["level1"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("level2");
                        return { count: inputs[0].count + 1 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "level3",
                    inputs: ["level2"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("level3");
                        return { count: inputs[0].count + 1 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeIncrementalGraph(db, graphDef);



            const result = await graph.pull("level3");

            expect(result).toBeDefined();
            expect(result.count).toBe(4);
            expect(computeCalls).toEqual(["level1", "level2", "level3"]);

            // Verify clean state by pulling again - should not recompute
            computeCalls.length = 0;
            const result2 = await graph.pull("level3");
            expect(result2.count).toBe(4);
            expect(computeCalls).toEqual([]);

            await db.close();
        });

        test("potentially-dirty with Unchanged should skip downstream recomputation", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const computeCalls = [];

            const input1Cell = { value: { count: 1 } };

            const graphDef = [
                {
                    output: "input1",
                    inputs: [],
                    computor: () => input1Cell.value,
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "level1",
                    inputs: ["input1"],
                    computor: (_inputs, oldValue) => {
                        computeCalls.push("level1");
                        if (!oldValue) {
                            return { count: 2 };
                        }
                        return makeUnchanged();
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "level2",
                    inputs: ["level1"],
                    computor: (_inputs, oldValue) => {
                        computeCalls.push("level2");
                        if (!oldValue) {
                            return { count: 3 };
                        }
                        return makeUnchanged();
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "level3",
                    inputs: ["level2"],
                    computor: (_inputs, oldValue) => {
                        computeCalls.push("level3");
                        if (!oldValue) {
                            return { count: 4 };
                        }
                        return makeUnchanged();
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeIncrementalGraph(db, graphDef);

            input1Cell.value = { count: 1 };
            await graph.invalidate("input1");
            await graph.pull("level3");
            expect(computeCalls).toEqual(["level1", "level2", "level3"]);
            
            computeCalls.length = 0;

            input1Cell.value = { count: 2 };
            await graph.invalidate("input1");
            
            const result = await graph.pull("level3");

            expect(result.count).toBe(4);
            expect(computeCalls).toEqual(["level1"]);

            // Verify clean state - subsequent pull should not recompute
            computeCalls.length = 0;
            const result2 = await graph.pull("level3");
            expect(result2.count).toBe(4);
            expect(computeCalls).toEqual([]);

            await db.close();
        });

        test("diamond graph with mixed dirty/potentially-dirty states", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const computeCalls = [];

            const graphDef = [
                {
                    output: "input",
                    inputs: [],
                    computor: (inputs, oldValue, _bindings) => oldValue || { value: 1 },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "left",
                    inputs: ["input"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("left");
                        return { value: inputs[0].value * 2 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "right",
                    inputs: ["input"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("right");
                        return { value: inputs[0].value * 3 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "output",
                    inputs: ["left", "right"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("output");
                        return { value: inputs[0].value + inputs[1].value };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeIncrementalGraph(db, graphDef);



            const result = await graph.pull("output");

            expect(result.value).toBe(5);
            expect(computeCalls).toEqual(["left", "right", "output"]);

            // Verify clean state
            computeCalls.length = 0;
            const result2 = await graph.pull("output");
            expect(result2.value).toBe(5);
            expect(computeCalls).toEqual([]);

            await db.close();
        });

        test("diamond graph where one path returns Unchanged should still compute meet node", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const computeCalls = [];

            const inputCell = { value: { value: 1 } };

            const graphDef = [
                {
                    output: "input",
                    inputs: [],
                    computor: () => inputCell.value,
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "left",
                    inputs: ["input"],
                    computor: (_inputs, oldValue) => {
                        computeCalls.push("left");
                        if (!oldValue) {
                            return { value: 10 };
                        }
                        return makeUnchanged();
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "right",
                    inputs: ["input"],
                    computor: (inputs, _oldValue) => {
                        computeCalls.push("right");
                        return { value: inputs[0].value * 5 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "output",
                    inputs: ["left", "right"],
                    computor: (inputs, _oldValue) => {
                        computeCalls.push("output");
                        return { value: inputs[0].value + inputs[1].value };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeIncrementalGraph(db, graphDef);

            inputCell.value = { value: 1 };
            await graph.invalidate("input");
            await graph.pull("output");
            expect(computeCalls).toEqual(["left", "right", "output"]);
            
            computeCalls.length = 0;
            inputCell.value = { value: 2 };
            await graph.invalidate("input");

            const result = await graph.pull("output");

            expect(result.value).toBe(20);
            expect(computeCalls).toEqual(["left", "right", "output"]);

            await db.close();
        });

        test("complex multi-level graph with various freshness states", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const computeCalls = [];

            const input1Cell = { value: { value: 1 } };
            const input2Cell = { value: { value: 2 } };

            const graphDef = [
                {
                    output: "input1",
                    inputs: [],
                    computor: () => input1Cell.value,
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "input2",
                    inputs: [],
                    computor: () => input2Cell.value,
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "nodeA",
                    inputs: ["input1"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("nodeA");
                        return { value: inputs[0].value * 10 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "nodeB",
                    inputs: ["input2"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("nodeB");
                        return { value: inputs[0].value * 10 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "nodeC",
                    inputs: ["nodeA", "nodeB"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("nodeC");
                        return { value: inputs[0].value + inputs[1].value };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "nodeD",
                    inputs: ["nodeC"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("nodeD");
                        return { value: inputs[0].value * 2 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "nodeE",
                    inputs: ["nodeC"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("nodeE");
                        return { value: inputs[0].value * 3 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeIncrementalGraph(db, graphDef);

            // Set up the graph properly
            input1Cell.value = { value: 1 };
            await graph.invalidate("input1");
            input2Cell.value = { value: 2 };
            await graph.invalidate("input2");
            
            // First pull to materialize all nodes with proper counters
            await graph.pull("nodeE");
            expect(computeCalls).toEqual(["nodeA", "nodeB", "nodeC", "nodeE"]);
            
            // Clear compute calls
            computeCalls.length = 0;
            
            // Now change input1, which should trigger recomputation
            input1Cell.value = { value: 1 }; // Same value, but counter increments
            await graph.invalidate("input1");

            // Complex graph:
            // input1 -> nodeA -> nodeC -> nodeE
            // input2 -> nodeB /     \-> nodeD

            const result = await graph.pull("nodeE");

            // input1=1 -> nodeA=10 -> nodeC(10+20=30) -> nodeE=90
            // nodeB should use counter optimization and skip recomputation (input2 counter unchanged)
            // nodeA recomputes, nodeC recomputes (nodeA's counter changed), nodeE recomputes (nodeC's counter changed)
            expect(result.value).toBe(90);
            expect(computeCalls).toEqual(["nodeA", "nodeC", "nodeE"]);

            await db.close();
        });

        test("mixed dirty and potentially-dirty with partial Unchanged", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const computeCalls = [];

            const inputCell = { value: { value: 1 } };

            const graphDef = [
                {
                    output: "input",
                    inputs: [],
                    computor: () => inputCell.value,
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "middle",
                    inputs: ["input"],
                    computor: (_inputs, oldValue) => {
                        computeCalls.push("middle");
                        if (!oldValue) {
                            return { value: 10 };
                        }
                        return makeUnchanged();
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "output",
                    inputs: ["middle"],
                    computor: (_inputs, oldValue) => {
                        computeCalls.push("output");
                        if (!oldValue) {
                            return { value: 20 };
                        }
                        return makeUnchanged();
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeIncrementalGraph(db, graphDef);

            inputCell.value = { value: 1 };
            await graph.invalidate("input");
            await graph.pull("output");
            expect(computeCalls).toEqual(["middle", "output"]);
            
            computeCalls.length = 0;
            
            inputCell.value = { value: 2 };
            await graph.invalidate("input");

            const result = await graph.pull("output");

            expect(result.value).toBe(20);
            expect(computeCalls).toEqual(["middle"]);

            // Verify clean state
            computeCalls.length = 0;
            const result2 = await graph.pull("output");
            expect(result2.value).toBe(20);
            expect(computeCalls).toEqual([]);

            await db.close();
        });

        test("recomputes when dependencies are potentially-dirty", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            let computeCount = 0;

            const graphDef = [
                {
                    output: "input1",
                    inputs: [],
                    computor: (inputs, oldValue, _bindings) =>
                        oldValue || { data: "new_data" },
                },
                {
                    output: "output1",
                    inputs: ["input1"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCount++;
                        return { data: inputs[0].data + "_processed" };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeIncrementalGraph(db, graphDef);



            const result = await graph.pull("output1");

            expect(result.data).toBe("new_data_processed");
            expect(computeCount).toBe(1);

            // Verify clean state
            const result2 = await graph.pull("output1");
            expect(result2.data).toBe("new_data_processed");
            expect(computeCount).toBe(1);

            await db.close();
        });

        test("wide diamond with multiple parallel paths - all paths must converge", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const graphDef = [
                {
                    output: "input",
                    inputs: [],
                    computor: (inputs, oldValue, _bindings) => oldValue || { value: 10 },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "pathA",
                    inputs: ["input"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("pathA");
                        return { value: inputs[0].value * 2 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "pathB",
                    inputs: ["input"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("pathB");
                        return { value: inputs[0].value * 3 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "pathC",
                    inputs: ["input"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("pathC");
                        return { value: inputs[0].value * 4 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "pathD",
                    inputs: ["input"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("pathD");
                        return { value: inputs[0].value * 5 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "output",
                    inputs: ["pathA", "pathB", "pathC", "pathD"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("output");
                        return {
                            value:
                                inputs[0].value +
                                inputs[1].value +
                                inputs[2].value +
                                inputs[3].value,
                        };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeIncrementalGraph(db, graphDef);


            const computeCalls = [];

            // Wide diamond: input -> pathA, pathB, pathC, pathD -> output
            // All paths are potentially-dirty, testing that the meet node waits for all inputs





            const result = await graph.pull("output");

            // Expected: 10*2 + 10*3 + 10*4 + 10*5 = 20 + 30 + 40 + 50 = 140
            // This tests that all parallel paths are evaluated before computing the output
            expect(result.value).toBe(140);
            expect(computeCalls).toEqual([
                "pathA",
                "pathB",
                "pathC",
                "pathD",
                "output",
            ]);

            await db.close();
        });

        test("multiple independent subgraphs - pulling one should not affect others", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const computeCalls = [];

            const graphDef = [
                {
                    output: "inputA",
                    inputs: [],
                    computor: (inputs, oldValue, _bindings) => oldValue || { value: 1 },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "outputA",
                    inputs: ["inputA"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("outputA");
                        return { value: inputs[0].value * 10 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "inputB",
                    inputs: [],
                    computor: (inputs, oldValue, _bindings) => oldValue || { value: 2 },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "outputB",
                    inputs: ["inputB"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("outputB");
                        return { value: inputs[0].value * 20 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeIncrementalGraph(db, graphDef);



            const resultA = await graph.pull("outputA");

            expect(resultA.value).toBe(10);
            expect(computeCalls).toEqual(["outputA"]);

            await db.close();
        });

        test("leaf node with no inputs starts clean - should return cached value", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const computeCalls = [];

            const leafCell = { value: { data: "external_data" } };

            const graphDef = [
                {
                    output: "leafNode",
                    inputs: [],
                    computor: () => {
                        computeCalls.push("leafNode");
                        return leafCell.value;
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeIncrementalGraph(db, graphDef);

            leafCell.value = { data: "initial_data" };
            await graph.invalidate("leafNode");
            
            const result1 = await graph.pull("leafNode");
            expect(result1.data).toBe("initial_data");
            expect(computeCalls).toEqual(["leafNode"]);

            computeCalls.length = 0;
            const result2 = await graph.pull("leafNode");
            expect(result2.data).toBe("initial_data");
            expect(computeCalls).toEqual([]);

            await db.close();
        });

        test("very deep linear chain - ensures stack doesn't overflow", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            // Create a chain of 50 nodes: node0 -> node1 -> ... -> node49
            // All nodes start potentially-dirty to force full recomputation
            const chainLength = 50;
            const graphDef = [];

            for (let i = 0; i < chainLength; i++) {
                if (i === 0) {
                    graphDef.push({
                        output: "node0",
                        inputs: [],
                        computor: (inputs, oldValue, _bindings) =>
                            oldValue || { value: 0 },
                    });
                } else {
                    graphDef.push({
                        output: `node${i}`,
                        inputs: [`node${i - 1}`],
                        computor: (inputs, _oldValue, _bindings) => {
                            return { value: inputs[0].value + 1 };
                        },
                    });
                }
            }

            const graph = makeIncrementalGraph(db, graphDef);



            const result = await graph.pull(`node${chainLength - 1}`);

            // Each node adds 1, so final value should be chainLength - 1 (starting from 0)
            // This tests that the algorithm handles deep recursion without stack overflow
            expect(result.value).toBe(chainLength - 1);

            await db.close();
        });

        test("diamond with asymmetric depths - one path longer than the other", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const graphDef = [
                {
                    output: "input",
                    inputs: [],
                    computor: (inputs, oldValue, _bindings) => oldValue || { value: 5 },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "shortPath",
                    inputs: ["input"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("shortPath");
                        return { value: inputs[0].value * 2 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "longA",
                    inputs: ["input"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("longA");
                        return { value: inputs[0].value + 1 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "longB",
                    inputs: ["longA"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("longB");
                        return { value: inputs[0].value + 1 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "longC",
                    inputs: ["longB"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("longC");
                        return { value: inputs[0].value + 1 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "output",
                    inputs: ["shortPath", "longC"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("output");
                        return { value: inputs[0].value + inputs[1].value };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeIncrementalGraph(db, graphDef);


            const computeCalls = [];

            // Asymmetric diamond:
            // input -> shortPath -> output
            //       -> longA -> longB -> longC -> output
            // Tests that both paths complete before computing output





            const result = await graph.pull("output");

            // shortPath: 5*2 = 10
            // longC: 5+1+1+1 = 8
            // output: 10 + 8 = 18
            // This verifies that asymmetric path lengths don't cause issues
            expect(result.value).toBe(18);
            expect(computeCalls).toContain("shortPath");
            expect(computeCalls).toContain("longA");
            expect(computeCalls).toContain("longB");
            expect(computeCalls).toContain("longC");
            expect(computeCalls).toContain("output");

            await db.close();
        });

        test("all inputs clean, output dirty - inconsistent state recovery", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const computeCalls = [];

            const input1Cell = { value: { value: 10 } };
            const input2Cell = { value: { value: 20 } };

            const graphDef = [
                {
                    output: "input1",
                    inputs: [],
                    computor: () => input1Cell.value,
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "input2",
                    inputs: [],
                    computor: () => input2Cell.value,
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "output",
                    inputs: ["input1", "input2"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("output");
                        return { value: inputs[0].value + inputs[1].value };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeIncrementalGraph(db, graphDef);

            input1Cell.value = { value: 10 };
            await graph.invalidate("input1");
            input2Cell.value = { value: 20 };
            await graph.invalidate("input2");
            await graph.pull("output");
            
            expect(computeCalls).toEqual(["output"]);
            computeCalls.length = 0;
            
            const result2 = await graph.pull("output");
            expect(result2.value).toBe(30);
            expect(computeCalls).toEqual([]);

            await db.close();
        });

        test("fan-out pattern - one input feeding multiple independent outputs", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const graphDef = [
                {
                    output: "input",
                    inputs: [],
                    computor: (inputs, oldValue, _bindings) => oldValue || { value: 7 },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "outputA",
                    inputs: ["input"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("outputA");
                        return { value: inputs[0].value * 2 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "outputB",
                    inputs: ["input"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("outputB");
                        return { value: inputs[0].value * 3 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "outputC",
                    inputs: ["input"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("outputC");
                        return { value: inputs[0].value * 4 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeIncrementalGraph(db, graphDef);


            const computeCalls = [];

            // Fan-out: input -> outputA, outputB, outputC (all independent)
            // When input changes, all outputs should recompute



            // Pull each output independently
            const resultA = await graph.pull("outputA");
            const resultB = await graph.pull("outputB");
            const resultC = await graph.pull("outputC");

            // Each output should compute independently based on the same input
            expect(resultA.value).toBe(14); // 7 * 2
            expect(resultB.value).toBe(21); // 7 * 3
            expect(resultC.value).toBe(28); // 7 * 4

            // Only one output should compute per pull (lazy evaluation)
            expect(computeCalls).toEqual(["outputA", "outputB", "outputC"]);

            await db.close();
        });

        test("nested diamonds - diamond within a diamond topology", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const graphDef = [
                {
                    output: "input",
                    inputs: [],
                    computor: (inputs, oldValue, _bindings) => oldValue || { value: 2 },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "leftA",
                    inputs: ["input"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("leftA");
                        return { value: inputs[0].value + 1 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "rightA",
                    inputs: ["input"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("rightA");
                        return { value: inputs[0].value + 2 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "middle",
                    inputs: ["leftA", "rightA"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("middle");
                        return { value: inputs[0].value + inputs[1].value };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "leftB",
                    inputs: ["middle"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("leftB");
                        return { value: inputs[0].value * 2 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "rightB",
                    inputs: ["middle"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("rightB");
                        return { value: inputs[0].value * 3 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "output",
                    inputs: ["leftB", "rightB"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("output");
                        return { value: inputs[0].value + inputs[1].value };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeIncrementalGraph(db, graphDef);


            const computeCalls = [];

            // Nested diamonds:
            // input -> leftA, rightA -> middle -> leftB, rightB -> output
            // This creates a more complex topology to test proper propagation






            const result = await graph.pull("output");

            // input: 2
            // leftA: 2+1=3, rightA: 2+2=4
            // middle: 3+4=7
            // leftB: 7*2=14, rightB: 7*3=21
            // output: 14+21=35
            // This tests that nested diamonds compute correctly
            expect(result.value).toBe(35);
            expect(computeCalls).toEqual([
                "leftA",
                "rightA",
                "middle",
                "leftB",
                "rightB",
                "output",
            ]);

            await db.close();
        });

        test("partial Unchanged in wide diamond - some paths unchanged, others changed", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const computeCalls = [];

            const inputCell = { value: { value: 5 } };

            const graphDef = [
                {
                    output: "input",
                    inputs: [],
                    computor: () => inputCell.value,
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "pathA",
                    inputs: ["input"],
                    computor: (_inputs, oldValue) => {
                        computeCalls.push("pathA");
                        if (!oldValue) {
                            return { value: 10 };
                        }
                        return makeUnchanged();
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "pathB",
                    inputs: ["input"],
                    computor: (inputs, _oldValue) => {
                        computeCalls.push("pathB");
                        return { value: inputs[0].value * 5 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "pathC",
                    inputs: ["input"],
                    computor: (_inputs, oldValue) => {
                        computeCalls.push("pathC");
                        if (!oldValue) {
                            return { value: 30 };
                        }
                        return makeUnchanged();
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "pathD",
                    inputs: ["input"],
                    computor: (inputs, _oldValue) => {
                        computeCalls.push("pathD");
                        return { value: inputs[0].value * 10 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "output",
                    inputs: ["pathA", "pathB", "pathC", "pathD"],
                    computor: (inputs, _oldValue) => {
                        computeCalls.push("output");
                        return {
                            value:
                                inputs[0].value +
                                inputs[1].value +
                                inputs[2].value +
                                inputs[3].value,
                        };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeIncrementalGraph(db, graphDef);

            inputCell.value = { value: 5 };
            await graph.invalidate("input");
            await graph.pull("output");
            expect(computeCalls).toEqual(["pathA", "pathB", "pathC", "pathD", "output"]);
            
            computeCalls.length = 0;
            inputCell.value = { value: 6 };
            await graph.invalidate("input");

            const result = await graph.pull("output");

            expect(result.value).toBe(130);
            expect(computeCalls).toEqual([
                "pathA",
                "pathB",
                "pathC",
                "pathD",
                "output",
            ]);

            await db.close();
        });

        test("all paths return Unchanged in wide diamond - output should not recompute", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const computeCalls = [];

            const inputCell = { value: { value: 5 } };

            const graphDef = [
                {
                    output: "input",
                    inputs: [],
                    computor: () => inputCell.value,
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "pathA",
                    inputs: ["input"],
                    computor: (_inputs, oldValue) => {
                        computeCalls.push("pathA");
                        if (!oldValue) {
                            return { value: 10 };
                        }
                        return makeUnchanged();
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "pathB",
                    inputs: ["input"],
                    computor: (_inputs, oldValue) => {
                        computeCalls.push("pathB");
                        if (!oldValue) {
                            return { value: 20 };
                        }
                        return makeUnchanged();
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "pathC",
                    inputs: ["input"],
                    computor: (_inputs, oldValue) => {
                        computeCalls.push("pathC");
                        if (!oldValue) {
                            return { value: 30 };
                        }
                        return makeUnchanged();
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "output",
                    inputs: ["pathA", "pathB", "pathC"],
                    computor: () => {
                        computeCalls.push("output");
                        return { value: 100 };
                    },
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeIncrementalGraph(db, graphDef);

            inputCell.value = { value: 5 };
            await graph.invalidate("input");
            await graph.pull("output");
            expect(computeCalls).toEqual(["pathA", "pathB", "pathC", "output"]);
            
            computeCalls.length = 0;
            
            inputCell.value = { value: 6 };
            await graph.invalidate("input");

            const result = await graph.pull("output");

            expect(result.value).toBe(100);
            expect(computeCalls).toEqual(["pathA", "pathB", "pathC"]);
            expect(computeCalls).not.toContain("output");

            // Verify clean state
            computeCalls.length = 0;
            const result2 = await graph.pull("output");
            expect(result2.value).toBe(100);
            expect(computeCalls).toEqual([]);

            await db.close();
        });
    });

    describe("Type guards", () => {
        test("isIncrementalGraph correctly identifies instances", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);
            const graph = makeIncrementalGraph(db, []);

            expect(isIncrementalGraph(graph)).toBe(true);
            expect(isIncrementalGraph({})).toBe(false);
            expect(isIncrementalGraph(null)).toBe(false);
            expect(isIncrementalGraph(undefined)).toBe(false);

            await db.close();
        });
    });



    describe("Schema Validation", () => {
        test("detects cycles in schema", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const graphDef = [
                {
                    output: "node1",
                    inputs: ["node2"],
                    computor: () => ({}),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "node2",
                    inputs: ["node1"],
                    computor: () => ({}),
                    isDeterministic: true,
                    hasSideEffects: false,
                }
            ];

            let error;
            try {
                makeIncrementalGraph(db, graphDef);
            } catch (e) {
                error = e;
            }
            expect(error).toBeDefined();
            expect(error.name).toBe("SchemaCycleError");

            await db.close();
        });

        test("detects overlapping schemas", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const graphDef = [
                {
                    output: "node(x)",
                    inputs: [],
                    computor: () => ({}),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "node(y)",
                    inputs: [],
                    computor: () => ({}),
                    isDeterministic: true,
                    hasSideEffects: false,
                }
            ];

            let error;
            try {
                makeIncrementalGraph(db, graphDef);
            } catch (e) {
                error = e;
            }
            expect(error).toBeDefined();
            expect(error.name).toBe("SchemaOverlapError");

            await db.close();
        });
    });
});
