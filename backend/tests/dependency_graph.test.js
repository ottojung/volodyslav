/**
 * Tests for generators/dependency_graph module.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { get: getDatabase } = require("../src/generators/database");
const {
    makeDependencyGraph,
    isDependencyGraph,
    makeUnchanged,
} = require("../src/generators/dependency_graph");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger } = require("./stubs");

/**
 * @typedef {import('../src/generators/database/types').DatabaseCapabilities} DatabaseCapabilities
 */

/**
 * Creates test capabilities with a temporary data directory.
 * @returns {DatabaseCapabilities & { tmpDir: string }}
 */
function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "dependency-graph-test-")
    );

    stubLogger(capabilities);

    // Override environment to use temp directory
    capabilities.environment = {
        pathToVolodyslavDataDirectory: jest.fn().mockReturnValue(tmpDir),
    };

    return { ...capabilities, tmpDir };
}

describe("generators/dependency_graph", () => {
    describe("makeDependencyGraph()", () => {
        test("creates and returns a dependency graph instance", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);
            const graph = makeDependencyGraph(db, []);

            expect(isDependencyGraph(graph)).toBe(true);

            await db.close();
        });
    });

    describe("pull()", () => {
        test("lazily evaluates only necessary nodes", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);
            const { freshnessKey } = require("../src/generators/database");

            // Track which computors were called
            const computeCalls = [];

            // Set up a chain: input1 -> level1 -> level2 -> level3
            await db.put("input1", { count: 1 });
            await db.put(freshnessKey("input1"), "potentially-outdated");

            const graphDef = [
                {
                    output: "input1",
                    inputs: [],
                    computor: (inputs, oldValue, _bindings) => oldValue || { count: 1 },
                },
                {
                    output: "level1",
                    inputs: ["input1"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("level1");
                        return { count: inputs[0].count + 1 };
                    },
                },
                {
                    output: "level2",
                    inputs: ["level1"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("level2");
                        return { count: inputs[0].count + 1 };
                    },
                },
                {
                    output: "level3",
                    inputs: ["level2"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("level3");
                        return { count: inputs[0].count + 1 };
                    },
                },
            ];

            const graph = makeDependencyGraph(db, graphDef);

            // Pull only level2 - should compute level1 and level2 but NOT level3
            const result = await graph.pull("level2");

            expect(result).toBeDefined();
            expect(result.count).toBe(3);
            expect(computeCalls).toEqual(["level1", "level2"]);

            // level3 should not have been computed
            const level3 = await db.get("level3");
            expect(level3).toBeUndefined();

            await db.close();
        });

        test("returns cached value when dependencies are clean", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);
            const { freshnessKey } = require("../src/generators/database");

            let computeCount = 0;

            await db.put("input1", { data: "test" });
            await db.put(freshnessKey("input1"), "up-to-date");

            await db.put("output1", { data: "cached_result" });
            await db.put(freshnessKey("output1"), "up-to-date");

            const graphDef = [
                {
                    output: "output1",
                    inputs: ["input1"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCount++;
                        return { data: inputs[0].data + "_computed" };
                    },
                },
            ];

            const graph = makeDependencyGraph(db, graphDef);
            const result = await graph.pull("output1");

            // Should return cached value without computing
            expect(result.data).toBe("cached_result");
            expect(computeCount).toBe(0);

            await db.close();
        });

        test("recomputes when dependencies are dirty", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);
            const { freshnessKey } = require("../src/generators/database");

            await db.put("input1", { data: "new_data" });
            await db.put(freshnessKey("input1"), "potentially-outdated");

            await db.put("output1", { data: "old_result" });
            await db.put(freshnessKey("output1"), "potentially-outdated");

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
                        return { data: inputs[0].data + "_processed" };
                    },
                },
            ];

            const graph = makeDependencyGraph(db, graphDef);
            const result = await graph.pull("output1");

            // Should have recomputed with new input
            expect(result.data).toBe("new_data_processed");

            // Both input and output should now be clean
            const input1Freshness = await db.get(freshnessKey("input1"));
            const output1Freshness = await db.get(freshnessKey("output1"));
            expect(input1Freshness).toBe("up-to-date");
            expect(output1Freshness).toBe("up-to-date");

            await db.close();
        });

        test("throws error when pulling non-graph nodes", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);

            await db.put("standalone", { data: "standalone_value" });

            const graph = makeDependencyGraph(db, []);

            await expect(graph.pull("standalone")).rejects.toThrow(
                "Node standalone not found in the dependency graph."
            );

            // Also verify error type
            await expect(graph.pull("standalone")).rejects.toThrow(
                /Node standalone not found in the dependency graph./
            );

            await db.close();
        });

        test("handles Unchanged return value", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);
            const { freshnessKey } = require("../src/generators/database");

            await db.put("input1", { data: "test" });
            await db.put(freshnessKey("input1"), "potentially-outdated");

            await db.put("output1", { data: "existing_value" });
            await db.put(freshnessKey("output1"), "up-to-date");

            const graphDef = [
                {
                    output: "input1",
                    inputs: [],
                    computor: (inputs, oldValue, _bindings) =>
                        oldValue || { data: "test" },
                },
                {
                    output: "output1",
                    inputs: ["input1"],
                    computor: () => {
                        return makeUnchanged();
                    },
                },
            ];

            const graph = makeDependencyGraph(db, graphDef);
            const result = await graph.pull("output1");

            // Should keep existing value and mark as clean
            expect(result.data).toBe("existing_value");
            const output1Freshness = await db.get(freshnessKey("output1"));
            expect(output1Freshness).toBe("up-to-date");

            await db.close();
        });

        test("handles potentially-dirty propagation in linear chain", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);
            const { freshnessKey } = require("../src/generators/database");

            const computeCalls = [];

            // Set up chain: input1 -> level1 -> level2 -> level3
            // input1 is dirty, others are potentially-dirty
            await db.put("input1", { count: 1 });
            await db.put(freshnessKey("input1"), "potentially-outdated");

            await db.put("level1", { count: 10 });
            await db.put(freshnessKey("level1"), "potentially-outdated");

            await db.put("level2", { count: 20 });
            await db.put(freshnessKey("level2"), "potentially-outdated");

            await db.put("level3", { count: 30 });
            await db.put(freshnessKey("level3"), "potentially-outdated");

            const graphDef = [
                {
                    output: "input1",
                    inputs: [],
                    computor: (inputs, oldValue, _bindings) => oldValue || { count: 1 },
                },
                {
                    output: "level1",
                    inputs: ["input1"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("level1");
                        return { count: inputs[0].count + 1 };
                    },
                },
                {
                    output: "level2",
                    inputs: ["level1"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("level2");
                        return { count: inputs[0].count + 1 };
                    },
                },
                {
                    output: "level3",
                    inputs: ["level2"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("level3");
                        return { count: inputs[0].count + 1 };
                    },
                },
            ];

            const graph = makeDependencyGraph(db, graphDef);
            const result = await graph.pull("level3");

            expect(result).toBeDefined();
            expect(result.count).toBe(4);
            expect(computeCalls).toEqual(["level1", "level2", "level3"]);

            // All should be clean after pull
            const input1Freshness = await db.get(freshnessKey("input1"));
            const level1Freshness = await db.get(freshnessKey("level1"));
            const level2Freshness = await db.get(freshnessKey("level2"));
            const level3Freshness = await db.get(freshnessKey("level3"));
            expect(input1Freshness).toBe("up-to-date");
            expect(level1Freshness).toBe("up-to-date");
            expect(level2Freshness).toBe("up-to-date");
            expect(level3Freshness).toBe("up-to-date");

            await db.close();
        });

        test("potentially-dirty with Unchanged should skip downstream recomputation", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);
            const { freshnessKey } = require("../src/generators/database");

            const computeCalls = [];

            // Set up chain: input1 -> level1 -> level2 -> level3
            // level1 returns Unchanged, so level2 and level3 should not recompute
            await db.put("input1", { count: 1 });
            await db.put(freshnessKey("input1"), "potentially-outdated");

            await db.put("level1", { count: 2 });
            await db.put(freshnessKey("level1"), "potentially-outdated");

            await db.put("level2", { count: 3 });
            await db.put(freshnessKey("level2"), "potentially-outdated");

            await db.put("level3", { count: 4 });
            await db.put(freshnessKey("level3"), "potentially-outdated");

            const graphDef = [
                {
                    output: "input1",
                    inputs: [],
                    computor: (inputs, oldValue, _bindings) => oldValue || { count: 1 },
                },
                {
                    output: "level1",
                    inputs: ["input1"],
                    computor: () => {
                        computeCalls.push("level1");
                        return makeUnchanged();
                    },
                },
                {
                    output: "level2",
                    inputs: ["level1"],
                    computor: () => {
                        computeCalls.push("level2");
                        return makeUnchanged();
                    },
                },
                {
                    output: "level3",
                    inputs: ["level2"],
                    computor: () => {
                        computeCalls.push("level3");
                        return makeUnchanged();
                    },
                },
            ];

            const graph = makeDependencyGraph(db, graphDef);
            const result = await graph.pull("level3");

            // Should only compute level1, then mark everything clean without further computation
            expect(result.count).toBe(4); // Original value
            expect(computeCalls).toEqual(["level1"]);

            // All should be clean after pull
            const level1Freshness = await db.get(freshnessKey("level1"));
            const level2Freshness = await db.get(freshnessKey("level2"));
            const level3Freshness = await db.get(freshnessKey("level3"));
            expect(level1Freshness).toBe("up-to-date");
            expect(level2Freshness).toBe("up-to-date");
            expect(level3Freshness).toBe("up-to-date");

            await db.close();
        });

        test("diamond graph with mixed dirty/potentially-dirty states", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);
            const { freshnessKey } = require("../src/generators/database");

            const computeCalls = [];

            // Diamond: input -> left + right -> output
            // Left path is dirty, right path is potentially-dirty
            await db.put("input", { value: 1 });
            await db.put(freshnessKey("input"), "potentially-outdated");

            await db.put("left", { value: 10 });
            await db.put(freshnessKey("left"), "potentially-outdated");

            await db.put("right", { value: 20 });
            await db.put(freshnessKey("right"), "potentially-outdated");

            await db.put("output", { value: 100 });
            await db.put(freshnessKey("output"), "potentially-outdated");

            const graphDef = [
                {
                    output: "input",
                    inputs: [],
                    computor: (inputs, oldValue, _bindings) => oldValue || { value: 1 },
                },
                {
                    output: "left",
                    inputs: ["input"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("left");
                        return { value: inputs[0].value * 2 };
                    },
                },
                {
                    output: "right",
                    inputs: ["input"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("right");
                        return { value: inputs[0].value * 3 };
                    },
                },
                {
                    output: "output",
                    inputs: ["left", "right"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("output");
                        return { value: inputs[0].value + inputs[1].value };
                    },
                },
            ];

            const graph = makeDependencyGraph(db, graphDef);
            const result = await graph.pull("output");

            expect(result.value).toBe(5); // 2 + 3
            expect(computeCalls).toEqual(["left", "right", "output"]);

            // All should be clean
            const inputFreshness = await db.get(freshnessKey("input"));
            const leftFreshness = await db.get(freshnessKey("left"));
            const rightFreshness = await db.get(freshnessKey("right"));
            const outputFreshness = await db.get(freshnessKey("output"));
            expect(inputFreshness).toBe("up-to-date");
            expect(leftFreshness).toBe("up-to-date");
            expect(rightFreshness).toBe("up-to-date");
            expect(outputFreshness).toBe("up-to-date");

            await db.close();
        });

        test("diamond graph where one path returns Unchanged should still compute meet node", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);
            const { freshnessKey } = require("../src/generators/database");

            const computeCalls = [];

            // Diamond: input -> left + right -> output
            // Left returns Unchanged, but right changes, so output must recompute
            await db.put("input", { value: 1 });
            await db.put(freshnessKey("input"), "potentially-outdated");

            await db.put("left", { value: 10 });
            await db.put(freshnessKey("left"), "potentially-outdated");

            await db.put("right", { value: 20 });
            await db.put(freshnessKey("right"), "potentially-outdated");

            await db.put("output", { value: 100 });
            await db.put(freshnessKey("output"), "potentially-outdated");

            const graphDef = [
                {
                    output: "input",
                    inputs: [],
                    computor: (inputs, oldValue, _bindings) => oldValue || { value: 1 },
                },
                {
                    output: "left",
                    inputs: ["input"],
                    computor: () => {
                        computeCalls.push("left");
                        return makeUnchanged();
                    },
                },
                {
                    output: "right",
                    inputs: ["input"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("right");
                        return { value: inputs[0].value * 5 };
                    },
                },
                {
                    output: "output",
                    inputs: ["left", "right"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("output");
                        return { value: inputs[0].value + inputs[1].value };
                    },
                },
            ];

            const graph = makeDependencyGraph(db, graphDef);
            const result = await graph.pull("output");

            // Left returns Unchanged (10), right computes to 5, output = 15
            expect(result.value).toBe(15);
            expect(computeCalls).toEqual(["left", "right", "output"]);

            // All should be clean
            const outputFreshness = await db.get(freshnessKey("output"));
            expect(outputFreshness).toBe("up-to-date");

            await db.close();
        });

        test("complex multi-level graph with various freshness states", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);
            const { freshnessKey } = require("../src/generators/database");

            const computeCalls = [];

            // Complex graph:
            // input1 -> nodeA -> nodeC -> nodeE
            // input2 -> nodeB /     \-> nodeD
            await db.put("input1", { value: 1 });
            await db.put(freshnessKey("input1"), "potentially-outdated");

            await db.put("input2", { value: 2 });
            await db.put(freshnessKey("input2"), "up-to-date");

            await db.put("nodeA", { value: 10 });
            await db.put(freshnessKey("nodeA"), "potentially-outdated");

            await db.put("nodeB", { value: 20 });
            await db.put(freshnessKey("nodeB"), "up-to-date");

            await db.put("nodeC", { value: 30 });
            await db.put(freshnessKey("nodeC"), "potentially-outdated");

            await db.put("nodeD", { value: 40 });
            await db.put(freshnessKey("nodeD"), "potentially-outdated");

            await db.put("nodeE", { value: 50 });
            await db.put(freshnessKey("nodeE"), "potentially-outdated");

            const graphDef = [
                {
                    output: "input1",
                    inputs: [],
                    computor: (inputs, oldValue, _bindings) => oldValue || { value: 1 },
                },
                {
                    output: "input2",
                    inputs: [],
                    computor: (inputs, oldValue, _bindings) => oldValue || { value: 2 },
                },
                {
                    output: "nodeA",
                    inputs: ["input1"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("nodeA");
                        return { value: inputs[0].value * 10 };
                    },
                },
                {
                    output: "nodeB",
                    inputs: ["input2"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("nodeB");
                        return { value: inputs[0].value * 10 };
                    },
                },
                {
                    output: "nodeC",
                    inputs: ["nodeA", "nodeB"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("nodeC");
                        return { value: inputs[0].value + inputs[1].value };
                    },
                },
                {
                    output: "nodeD",
                    inputs: ["nodeC"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("nodeD");
                        return { value: inputs[0].value * 2 };
                    },
                },
                {
                    output: "nodeE",
                    inputs: ["nodeC"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("nodeE");
                        return { value: inputs[0].value * 3 };
                    },
                },
            ];

            const graph = makeDependencyGraph(db, graphDef);
            const result = await graph.pull("nodeE");

            // input1=1 -> nodeA=10 -> nodeC(10+20=30) -> nodeE=90
            // nodeB is clean, so not recomputed, uses cached value 20
            expect(result.value).toBe(90);
            expect(computeCalls).toEqual(["nodeA", "nodeC", "nodeE"]);

            await db.close();
        });

        test("mixed dirty and potentially-dirty with partial Unchanged", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);
            const { freshnessKey } = require("../src/generators/database");

            const computeCalls = [];

            // Chain with mixed states: dirty -> potentially-dirty -> potentially-dirty
            // Middle node returns Unchanged
            await db.put("input", { value: 1 });
            await db.put(freshnessKey("input"), "potentially-outdated");

            await db.put("middle", { value: 10 });
            await db.put(freshnessKey("middle"), "potentially-outdated");

            await db.put("output", { value: 20 });
            await db.put(freshnessKey("output"), "potentially-outdated");

            const graphDef = [
                {
                    output: "input",
                    inputs: [],
                    computor: (inputs, oldValue, _bindings) => oldValue || { value: 1 },
                },
                {
                    output: "middle",
                    inputs: ["input"],
                    computor: () => {
                        computeCalls.push("middle");
                        return makeUnchanged();
                    },
                },
                {
                    output: "output",
                    inputs: ["middle"],
                    computor: () => {
                        computeCalls.push("output");
                        return makeUnchanged();
                    },
                },
            ];

            const graph = makeDependencyGraph(db, graphDef);
            const result = await graph.pull("output");

            // Middle returns Unchanged, so output should not recompute
            expect(result.value).toBe(20);
            expect(computeCalls).toEqual(["middle"]);

            // All should be clean
            const inputFreshness = await db.get(freshnessKey("input"));
            const middleFreshness = await db.get(freshnessKey("middle"));
            const outputFreshness = await db.get(freshnessKey("output"));
            expect(inputFreshness).toBe("up-to-date");
            expect(middleFreshness).toBe("up-to-date");
            expect(outputFreshness).toBe("up-to-date");

            await db.close();
        });

        test("recomputes when dependencies are potentially-dirty", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);
            const { freshnessKey } = require("../src/generators/database");

            await db.put("input1", { data: "new_data" });
            await db.put(freshnessKey("input1"), "potentially-outdated");

            await db.put("output1", { data: "old_result" });
            await db.put(freshnessKey("output1"), "potentially-outdated");

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
                        return { data: inputs[0].data + "_processed" };
                    },
                },
            ];

            const graph = makeDependencyGraph(db, graphDef);
            const result = await graph.pull("output1");

            // Should have recomputed with new input
            expect(result.data).toBe("new_data_processed");

            // Both input and output should now be clean
            const input1Freshness = await db.get(freshnessKey("input1"));
            const output1Freshness = await db.get(freshnessKey("output1"));
            expect(input1Freshness).toBe("up-to-date");
            expect(output1Freshness).toBe("up-to-date");

            await db.close();
        });

        test("wide diamond with multiple parallel paths - all paths must converge", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);
            const { freshnessKey } = require("../src/generators/database");

            const computeCalls = [];

            // Wide diamond: input -> pathA, pathB, pathC, pathD -> output
            // All paths are potentially-dirty, testing that the meet node waits for all inputs
            await db.put("input", { value: 10 });
            await db.put(freshnessKey("input"), "potentially-outdated");

            await db.put("pathA", { value: 100 });
            await db.put(freshnessKey("pathA"), "potentially-outdated");

            await db.put("pathB", { value: 200 });
            await db.put(freshnessKey("pathB"), "potentially-outdated");

            await db.put("pathC", { value: 300 });
            await db.put(freshnessKey("pathC"), "potentially-outdated");

            await db.put("pathD", { value: 400 });
            await db.put(freshnessKey("pathD"), "potentially-outdated");

            await db.put("output", { value: 1000 });
            await db.put(freshnessKey("output"), "potentially-outdated");

            const graphDef = [
                {
                    output: "input",
                    inputs: [],
                    computor: (inputs, oldValue, _bindings) => oldValue || { value: 10 },
                },
                {
                    output: "pathA",
                    inputs: ["input"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("pathA");
                        return { value: inputs[0].value * 2 };
                    },
                },
                {
                    output: "pathB",
                    inputs: ["input"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("pathB");
                        return { value: inputs[0].value * 3 };
                    },
                },
                {
                    output: "pathC",
                    inputs: ["input"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("pathC");
                        return { value: inputs[0].value * 4 };
                    },
                },
                {
                    output: "pathD",
                    inputs: ["input"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("pathD");
                        return { value: inputs[0].value * 5 };
                    },
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
                },
            ];

            const graph = makeDependencyGraph(db, graphDef);
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
            const db = await getDatabase(capabilities);
            const { freshnessKey } = require("../src/generators/database");

            const computeCalls = [];

            // Two independent graphs:
            // Graph 1: inputA -> outputA
            // Graph 2: inputB -> outputB
            // Pulling outputA should not compute anything in graph 2
            await db.put("inputA", { value: 1 });
            await db.put(freshnessKey("inputA"), "potentially-outdated");

            await db.put("inputB", { value: 2 });
            await db.put(freshnessKey("inputB"), "potentially-outdated");

            const graphDef = [
                {
                    output: "inputA",
                    inputs: [],
                    computor: (inputs, oldValue, _bindings) => oldValue || { value: 1 },
                },
                {
                    output: "outputA",
                    inputs: ["inputA"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("outputA");
                        return { value: inputs[0].value * 10 };
                    },
                },
                {
                    output: "inputB",
                    inputs: [],
                    computor: (inputs, oldValue, _bindings) => oldValue || { value: 2 },
                },
                {
                    output: "outputB",
                    inputs: ["inputB"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("outputB");
                        return { value: inputs[0].value * 20 };
                    },
                },
            ];

            const graph = makeDependencyGraph(db, graphDef);
            const resultA = await graph.pull("outputA");

            // Only outputA should have been computed, not outputB
            // This tests that the graph correctly identifies and processes only the necessary subgraph
            expect(resultA.value).toBe(10);
            expect(computeCalls).toEqual(["outputA"]);

            // OutputB should not exist in the database yet
            const outputB = await db.get("outputB");
            expect(outputB).toBeUndefined();

            await db.close();
        });

        test("leaf node with no inputs starts clean - should return cached value", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);
            const { freshnessKey } = require("../src/generators/database");

            const computeCalls = [];

            // A leaf node (no inputs) that's already clean
            // This represents external data that hasn't changed
            await db.put("leafNode", { data: "cached_external_data" });
            await db.put(freshnessKey("leafNode"), "up-to-date");

            const graphDef = [
                {
                    output: "leafNode",
                    inputs: [],
                    computor: () => {
                        computeCalls.push("leafNode");
                        return { data: "freshly_computed_data" };
                    },
                },
            ];

            const graph = makeDependencyGraph(db, graphDef);
            const result = await graph.pull("leafNode");

            // Should use cached value without calling computor
            // This is important for external data sources that are expensive to query
            expect(result.data).toBe("cached_external_data");
            expect(computeCalls).toEqual([]);

            await db.close();
        });

        test("very deep linear chain - ensures stack doesn't overflow", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);
            const { freshnessKey } = require("../src/generators/database");

            // Create a chain of 50 nodes: node0 -> node1 -> ... -> node49
            // All nodes start potentially-dirty to force full recomputation
            const chainLength = 50;
            const graphDef = [];

            for (let i = 0; i < chainLength; i++) {
                await db.put(`node${i}`, { value: i * 100 });
                await db.put(freshnessKey(`node${i}`), "potentially-outdated");

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

            const graph = makeDependencyGraph(db, graphDef);
            const result = await graph.pull(`node${chainLength - 1}`);

            // Each node adds 1, so final value should be chainLength - 1 (starting from 0)
            // This tests that the algorithm handles deep recursion without stack overflow
            expect(result.value).toBe(chainLength - 1);

            await db.close();
        });

        test("diamond with asymmetric depths - one path longer than the other", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);
            const { freshnessKey } = require("../src/generators/database");

            const computeCalls = [];

            // Asymmetric diamond:
            // input -> shortPath -> output
            //       -> longA -> longB -> longC -> output
            // Tests that both paths complete before computing output
            await db.put("input", { value: 5 });
            await db.put(freshnessKey("input"), "potentially-outdated");

            await db.put("shortPath", { value: 0 });
            await db.put(freshnessKey("shortPath"), "potentially-outdated");

            await db.put("longA", { value: 0 });
            await db.put(freshnessKey("longA"), "potentially-outdated");

            await db.put("longB", { value: 0 });
            await db.put(freshnessKey("longB"), "potentially-outdated");

            await db.put("longC", { value: 0 });
            await db.put(freshnessKey("longC"), "potentially-outdated");

            await db.put("output", { value: 0 });
            await db.put(freshnessKey("output"), "potentially-outdated");

            const graphDef = [
                {
                    output: "input",
                    inputs: [],
                    computor: (inputs, oldValue, _bindings) => oldValue || { value: 5 },
                },
                {
                    output: "shortPath",
                    inputs: ["input"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("shortPath");
                        return { value: inputs[0].value * 2 };
                    },
                },
                {
                    output: "longA",
                    inputs: ["input"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("longA");
                        return { value: inputs[0].value + 1 };
                    },
                },
                {
                    output: "longB",
                    inputs: ["longA"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("longB");
                        return { value: inputs[0].value + 1 };
                    },
                },
                {
                    output: "longC",
                    inputs: ["longB"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("longC");
                        return { value: inputs[0].value + 1 };
                    },
                },
                {
                    output: "output",
                    inputs: ["shortPath", "longC"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("output");
                        return { value: inputs[0].value + inputs[1].value };
                    },
                },
            ];

            const graph = makeDependencyGraph(db, graphDef);
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
            const db = await getDatabase(capabilities);
            const { freshnessKey } = require("../src/generators/database");

            // This represents an inconsistent state where inputs are clean but output is dirty
            // This shouldn't happen in normal operation but could occur after a crash or bug
            // The graph should recover by treating the output as potentially-dirty
            await db.put("input1", { value: 10 });
            await db.put(freshnessKey("input1"), "up-to-date");

            await db.put("input2", { value: 20 });
            await db.put(freshnessKey("input2"), "up-to-date");

            await db.put("output", { value: 999 });
            await db.put(freshnessKey("output"), "potentially-outdated");

            const computeCalls = [];

            const graphDef = [
                {
                    output: "input1",
                    inputs: [],
                    computor: (inputs, oldValue, _bindings) => {
                        computeCalls.push("input1");
                        return oldValue || { value: 10 };
                    },
                },
                {
                    output: "input2",
                    inputs: [],
                    computor: (inputs, oldValue, _bindings) => {
                        computeCalls.push("input2");
                        return oldValue || { value: 20 };
                    },
                },
                {
                    output: "output",
                    inputs: ["input1", "input2"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("output");
                        return { value: inputs[0].value + inputs[1].value };
                    },
                },
            ];

            const graph = makeDependencyGraph(db, graphDef);
            const result = await graph.pull("output");

            // The output should be recomputed because it's dirty, even though inputs are clean
            // This ensures the system can recover from inconsistent states
            expect(result.value).toBe(30);
            expect(computeCalls).toEqual(["output"]);

            // Output should now be clean
            const outputFreshness = await db.get(freshnessKey("output"));
            expect(outputFreshness).toBe("up-to-date");

            await db.close();
        });

        test("fan-out pattern - one input feeding multiple independent outputs", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);
            const { freshnessKey } = require("../src/generators/database");

            const computeCalls = [];

            // Fan-out: input -> outputA, outputB, outputC (all independent)
            // When input changes, all outputs should recompute
            await db.put("input", { value: 7 });
            await db.put(freshnessKey("input"), "potentially-outdated");

            await db.put("outputA", { value: 0 });
            await db.put(freshnessKey("outputA"), "potentially-outdated");

            await db.put("outputB", { value: 0 });
            await db.put(freshnessKey("outputB"), "potentially-outdated");

            await db.put("outputC", { value: 0 });
            await db.put(freshnessKey("outputC"), "potentially-outdated");

            const graphDef = [
                {
                    output: "input",
                    inputs: [],
                    computor: (inputs, oldValue, _bindings) => oldValue || { value: 7 },
                },
                {
                    output: "outputA",
                    inputs: ["input"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("outputA");
                        return { value: inputs[0].value * 2 };
                    },
                },
                {
                    output: "outputB",
                    inputs: ["input"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("outputB");
                        return { value: inputs[0].value * 3 };
                    },
                },
                {
                    output: "outputC",
                    inputs: ["input"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("outputC");
                        return { value: inputs[0].value * 4 };
                    },
                },
            ];

            const graph = makeDependencyGraph(db, graphDef);

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
            const db = await getDatabase(capabilities);
            const { freshnessKey } = require("../src/generators/database");

            const computeCalls = [];

            // Nested diamonds:
            // input -> leftA, rightA -> middle -> leftB, rightB -> output
            // This creates a more complex topology to test proper propagation
            await db.put("input", { value: 2 });
            await db.put(freshnessKey("input"), "potentially-outdated");

            await db.put("leftA", { value: 0 });
            await db.put(freshnessKey("leftA"), "potentially-outdated");

            await db.put("rightA", { value: 0 });
            await db.put(freshnessKey("rightA"), "potentially-outdated");

            await db.put("middle", { value: 0 });
            await db.put(freshnessKey("middle"), "potentially-outdated");

            await db.put("leftB", { value: 0 });
            await db.put(freshnessKey("leftB"), "potentially-outdated");

            await db.put("rightB", { value: 0 });
            await db.put(freshnessKey("rightB"), "potentially-outdated");

            await db.put("output", { value: 0 });
            await db.put(freshnessKey("output"), "potentially-outdated");

            const graphDef = [
                {
                    output: "input",
                    inputs: [],
                    computor: (inputs, oldValue, _bindings) => oldValue || { value: 2 },
                },
                {
                    output: "leftA",
                    inputs: ["input"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("leftA");
                        return { value: inputs[0].value + 1 };
                    },
                },
                {
                    output: "rightA",
                    inputs: ["input"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("rightA");
                        return { value: inputs[0].value + 2 };
                    },
                },
                {
                    output: "middle",
                    inputs: ["leftA", "rightA"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("middle");
                        return { value: inputs[0].value + inputs[1].value };
                    },
                },
                {
                    output: "leftB",
                    inputs: ["middle"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("leftB");
                        return { value: inputs[0].value * 2 };
                    },
                },
                {
                    output: "rightB",
                    inputs: ["middle"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("rightB");
                        return { value: inputs[0].value * 3 };
                    },
                },
                {
                    output: "output",
                    inputs: ["leftB", "rightB"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("output");
                        return { value: inputs[0].value + inputs[1].value };
                    },
                },
            ];

            const graph = makeDependencyGraph(db, graphDef);
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
            const db = await getDatabase(capabilities);
            const { freshnessKey } = require("../src/generators/database");

            const computeCalls = [];

            // Wide diamond where some paths return Unchanged and others change
            // input -> pathA (unchanged), pathB (changed), pathC (unchanged), pathD (changed) -> output
            // Output must still recompute because at least one input changed
            await db.put("input", { value: 5 });
            await db.put(freshnessKey("input"), "potentially-outdated");

            await db.put("pathA", { value: 10 });
            await db.put(freshnessKey("pathA"), "potentially-outdated");

            await db.put("pathB", { value: 20 });
            await db.put(freshnessKey("pathB"), "potentially-outdated");

            await db.put("pathC", { value: 30 });
            await db.put(freshnessKey("pathC"), "potentially-outdated");

            await db.put("pathD", { value: 40 });
            await db.put(freshnessKey("pathD"), "potentially-outdated");

            await db.put("output", { value: 999 });
            await db.put(freshnessKey("output"), "potentially-outdated");

            const graphDef = [
                {
                    output: "input",
                    inputs: [],
                    computor: (inputs, oldValue, _bindings) => oldValue || { value: 5 },
                },
                {
                    output: "pathA",
                    inputs: ["input"],
                    computor: () => {
                        computeCalls.push("pathA");
                        return makeUnchanged(); // Unchanged
                    },
                },
                {
                    output: "pathB",
                    inputs: ["input"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("pathB");
                        return { value: inputs[0].value * 5 }; // Changed
                    },
                },
                {
                    output: "pathC",
                    inputs: ["input"],
                    computor: () => {
                        computeCalls.push("pathC");
                        return makeUnchanged(); // Unchanged
                    },
                },
                {
                    output: "pathD",
                    inputs: ["input"],
                    computor: (inputs, _oldValue, _bindings) => {
                        computeCalls.push("pathD");
                        return { value: inputs[0].value * 10 }; // Changed
                    },
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
                },
            ];

            const graph = makeDependencyGraph(db, graphDef);
            const result = await graph.pull("output");

            // pathA: 10 (unchanged), pathB: 25 (5*5), pathC: 30 (unchanged), pathD: 50 (5*10)
            // output: 10+25+30+50 = 115
            // This verifies that partial Unchanged results still trigger downstream recomputation
            expect(result.value).toBe(115);
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
            const db = await getDatabase(capabilities);
            const { freshnessKey } = require("../src/generators/database");

            const computeCalls = [];

            // Wide diamond where ALL paths return Unchanged
            // input -> pathA, pathB, pathC -> output (all unchanged)
            // Output should NOT recompute because all inputs are unchanged
            await db.put("input", { value: 5 });
            await db.put(freshnessKey("input"), "potentially-outdated");

            await db.put("pathA", { value: 10 });
            await db.put(freshnessKey("pathA"), "potentially-outdated");

            await db.put("pathB", { value: 20 });
            await db.put(freshnessKey("pathB"), "potentially-outdated");

            await db.put("pathC", { value: 30 });
            await db.put(freshnessKey("pathC"), "potentially-outdated");

            await db.put("output", { value: 100 });
            await db.put(freshnessKey("output"), "potentially-outdated");

            const graphDef = [
                {
                    output: "input",
                    inputs: [],
                    computor: (inputs, oldValue, _bindings) => oldValue || { value: 5 },
                },
                {
                    output: "pathA",
                    inputs: ["input"],
                    computor: () => {
                        computeCalls.push("pathA");
                        return makeUnchanged();
                    },
                },
                {
                    output: "pathB",
                    inputs: ["input"],
                    computor: () => {
                        computeCalls.push("pathB");
                        return makeUnchanged();
                    },
                },
                {
                    output: "pathC",
                    inputs: ["input"],
                    computor: () => {
                        computeCalls.push("pathC");
                        return makeUnchanged();
                    },
                },
                {
                    output: "output",
                    inputs: ["pathA", "pathB", "pathC"],
                    computor: () => {
                        computeCalls.push("output");
                        return { value: 999 };
                    },
                },
            ];

            const graph = makeDependencyGraph(db, graphDef);
            const result = await graph.pull("output");

            // All paths returned Unchanged, so output should not recompute
            // This is an optimization - if all inputs are unchanged, output remains unchanged
            expect(result.value).toBe(100); // Original cached value
            expect(computeCalls).toEqual(["pathA", "pathB", "pathC"]);
            expect(computeCalls).not.toContain("output");

            await db.close();
        });
    });

    describe("Type guards", () => {
        test("isDependencyGraph correctly identifies instances", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);
            const graph = makeDependencyGraph(db, []);

            expect(isDependencyGraph(graph)).toBe(true);
            expect(isDependencyGraph({})).toBe(false);
            expect(isDependencyGraph(null)).toBe(false);
            expect(isDependencyGraph(undefined)).toBe(false);

            await db.close();
        });
    });

    describe("Static node canonicalization (T2)", () => {
        test("nodes with extra whitespace are properly canonicalized internally", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);
            const { freshnessKey } = require("../src/generators/database");

            // Create node with extra whitespace in output and inputs
            const graphDef = [
                {
                    output: "base",
                    inputs: [],
                    computor: (_inputs, oldValue, _bindings) => oldValue || { value: 1 },
                },
                {
                    output: 'derived ( "data"  )', // Extra spaces - should be canonicalized
                    inputs: ["  base  "], // Extra spaces - should be canonicalized
                    computor: (inputs, _oldValue, _bindings) => {
                        return { value: inputs[0].value * 2 };
                    },
                },
            ];

            const graph = makeDependencyGraph(db, graphDef);

            // Set base value
            await graph.set("base", { value: 5 });

            // Pull using canonical form (no spaces)
            const result = await graph.pull('derived("data")');
            expect(result.value).toBe(10);

            // Verify value is stored under canonical key
            const stored = await db.getValue('derived("data")');
            expect(stored).toEqual({ value: 10 });

            // Verify freshness is under canonical key
            const freshness = await db.getFreshness(freshnessKey('derived("data")'));
            expect(freshness).toBe("up-to-date");

            // Setting base should invalidate derived (via canonical key)
            await graph.set("base", { value: 10 });

            // Pull derived again - should recompute
            const result2 = await graph.pull('derived("data")');
            expect(result2.value).toBe(20);

            await db.close();
        });
    });

    describe("Debug Interface", () => {
        test("debugGetFreshness returns correct status", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);

            const graphDef = [
                {
                    output: "node1",
                    inputs: [],
                    computor: (_inputs, oldValue) => oldValue || { val: 1 },
                },
                {
                    output: "node2",
                    inputs: ["node1"],
                    computor: ([n1]) => ({ val: n1.val + 1 }),
                }
            ];

            const graph = makeDependencyGraph(db, graphDef);

            // Initially missing
            expect(await graph.debugGetFreshness("node1")).toBe("missing");

            // Set node1 -> up-to-date
            await graph.set("node1", { val: 10 });
            expect(await graph.debugGetFreshness("node1")).toBe("up-to-date");
            
            // node2 should be potentially-outdated (propagated from set)
            expect(await graph.debugGetFreshness("node2")).toBe("potentially-outdated");

            // Pull node2 -> up-to-date
            await graph.pull("node2");
            expect(await graph.debugGetFreshness("node2")).toBe("up-to-date");

            await db.close();
        });

        test("debugListMaterializedNodes lists all materialized nodes", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);

            const graphDef = [
                {
                    output: "node1",
                    inputs: [],
                    computor: (_inputs, oldValue) => oldValue || { val: 1 },
                },
                {
                    output: "node2",
                    inputs: ["node1"],
                    computor: ([n1]) => ({ val: n1.val + 1 }),
                }
            ];

            const graph = makeDependencyGraph(db, graphDef);

            // Initially empty
            expect(await graph.debugListMaterializedNodes()).toEqual([]);

            // Set node1
            await graph.set("node1", { val: 10 });
            
            const nodes = await graph.debugListMaterializedNodes();
            expect(nodes).toContain("node1");
            expect(nodes).not.toContain("node2");

            // Pull node2
            await graph.pull("node2");
            
            const nodes2 = await graph.debugListMaterializedNodes();
            expect(nodes2).toContain("node1");
            expect(nodes2).toContain("node2");
            expect(nodes2.length).toBe(2);

            await db.close();
        });
    });

    describe("Schema Validation", () => {
        test("detects cycles in schema", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);

            const graphDef = [
                {
                    output: "node1",
                    inputs: ["node2"],
                    computor: () => ({}),
                },
                {
                    output: "node2",
                    inputs: ["node1"],
                    computor: () => ({}),
                }
            ];

            let error;
            try {
                makeDependencyGraph(db, graphDef);
            } catch (e) {
                error = e;
            }
            expect(error).toBeDefined();
            expect(error.name).toBe("SchemaCycleError");

            await db.close();
        });

        test("detects overlapping schemas", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);

            const graphDef = [
                {
                    output: "node(x)",
                    inputs: [],
                    computor: () => ({}),
                },
                {
                    output: "node(y)",
                    inputs: [],
                    computor: () => ({}),
                }
            ];

            let error;
            try {
                makeDependencyGraph(db, graphDef);
            } catch (e) {
                error = e;
            }
            expect(error).toBeDefined();
            expect(error.name).toBe("SchemaOverlapError");

            await db.close();
        });
    });
});
