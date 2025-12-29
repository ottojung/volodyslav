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
            await db.put(freshnessKey("input1"), "dirty");

            const graphDef = [
                {
                    output: "input1",
                    inputs: [],
                    computor: (inputs, oldValue) => oldValue || { count: 1 },
                },
                {
                    output: "level1",
                    inputs: ["input1"],
                    computor: (inputs) => {
                        computeCalls.push("level1");
                        return { count: inputs[0].count + 1 };
                    },
                },
                {
                    output: "level2",
                    inputs: ["level1"],
                    computor: (inputs) => {
                        computeCalls.push("level2");
                        return { count: inputs[0].count + 1 };
                    },
                },
                {
                    output: "level3",
                    inputs: ["level2"],
                    computor: (inputs) => {
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
            await db.put(freshnessKey("input1"), "clean");

            await db.put("output1", { data: "cached_result" });
            await db.put(freshnessKey("output1"), "clean");

            const graphDef = [
                {
                    output: "output1",
                    inputs: ["input1"],
                    computor: (inputs) => {
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
            await db.put(freshnessKey("input1"), "dirty");

            await db.put("output1", { data: "old_result" });
            await db.put(freshnessKey("output1"), "clean");

            const graphDef = [
                {
                    output: "input1",
                    inputs: [],
                    computor: (inputs, oldValue) =>
                        oldValue || { data: "new_data" },
                },
                {
                    output: "output1",
                    inputs: ["input1"],
                    computor: (inputs) => {
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
            expect(input1Freshness).toBe("clean");
            expect(output1Freshness).toBe("clean");

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
            await db.put(freshnessKey("input1"), "dirty");

            await db.put("output1", { data: "existing_value" });
            await db.put(freshnessKey("output1"), "clean");

            const graphDef = [
                {
                    output: "input1",
                    inputs: [],
                    computor: (inputs, oldValue) =>
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
            expect(output1Freshness).toBe("clean");

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
            await db.put(freshnessKey("input1"), "dirty");

            await db.put("level1", { count: 10 });
            await db.put(freshnessKey("level1"), "potentially-dirty");

            await db.put("level2", { count: 20 });
            await db.put(freshnessKey("level2"), "potentially-dirty");

            await db.put("level3", { count: 30 });
            await db.put(freshnessKey("level3"), "potentially-dirty");

            const graphDef = [
                {
                    output: "input1",
                    inputs: [],
                    computor: (inputs, oldValue) => oldValue || { count: 1 },
                },
                {
                    output: "level1",
                    inputs: ["input1"],
                    computor: (inputs) => {
                        computeCalls.push("level1");
                        return { count: inputs[0].count + 1 };
                    },
                },
                {
                    output: "level2",
                    inputs: ["level1"],
                    computor: (inputs) => {
                        computeCalls.push("level2");
                        return { count: inputs[0].count + 1 };
                    },
                },
                {
                    output: "level3",
                    inputs: ["level2"],
                    computor: (inputs) => {
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
            expect(input1Freshness).toBe("clean");
            expect(level1Freshness).toBe("clean");
            expect(level2Freshness).toBe("clean");
            expect(level3Freshness).toBe("clean");

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
            await db.put(freshnessKey("input1"), "potentially-dirty");

            await db.put("level1", { count: 2 });
            await db.put(freshnessKey("level1"), "potentially-dirty");

            await db.put("level2", { count: 3 });
            await db.put(freshnessKey("level2"), "potentially-dirty");

            await db.put("level3", { count: 4 });
            await db.put(freshnessKey("level3"), "potentially-dirty");

            const graphDef = [
                {
                    output: "input1",
                    inputs: [],
                    computor: (inputs, oldValue) => oldValue || { count: 1 },
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
            expect(level1Freshness).toBe("clean");
            expect(level2Freshness).toBe("clean");
            expect(level3Freshness).toBe("clean");

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
            await db.put(freshnessKey("input"), "dirty");

            await db.put("left", { value: 10 });
            await db.put(freshnessKey("left"), "potentially-dirty");

            await db.put("right", { value: 20 });
            await db.put(freshnessKey("right"), "potentially-dirty");

            await db.put("output", { value: 100 });
            await db.put(freshnessKey("output"), "potentially-dirty");

            const graphDef = [
                {
                    output: "input",
                    inputs: [],
                    computor: (inputs, oldValue) => oldValue || { value: 1 },
                },
                {
                    output: "left",
                    inputs: ["input"],
                    computor: (inputs) => {
                        computeCalls.push("left");
                        return { value: inputs[0].value * 2 };
                    },
                },
                {
                    output: "right",
                    inputs: ["input"],
                    computor: (inputs) => {
                        computeCalls.push("right");
                        return { value: inputs[0].value * 3 };
                    },
                },
                {
                    output: "output",
                    inputs: ["left", "right"],
                    computor: (inputs) => {
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
            expect(inputFreshness).toBe("clean");
            expect(leftFreshness).toBe("clean");
            expect(rightFreshness).toBe("clean");
            expect(outputFreshness).toBe("clean");

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
            await db.put(freshnessKey("input"), "potentially-dirty");

            await db.put("left", { value: 10 });
            await db.put(freshnessKey("left"), "potentially-dirty");

            await db.put("right", { value: 20 });
            await db.put(freshnessKey("right"), "potentially-dirty");

            await db.put("output", { value: 100 });
            await db.put(freshnessKey("output"), "potentially-dirty");

            const graphDef = [
                {
                    output: "input",
                    inputs: [],
                    computor: (inputs, oldValue) => oldValue || { value: 1 },
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
                    computor: (inputs) => {
                        computeCalls.push("right");
                        return { value: inputs[0].value * 5 };
                    },
                },
                {
                    output: "output",
                    inputs: ["left", "right"],
                    computor: (inputs) => {
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
            expect(outputFreshness).toBe("clean");

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
            await db.put(freshnessKey("input1"), "dirty");

            await db.put("input2", { value: 2 });
            await db.put(freshnessKey("input2"), "clean");

            await db.put("nodeA", { value: 10 });
            await db.put(freshnessKey("nodeA"), "potentially-dirty");

            await db.put("nodeB", { value: 20 });
            await db.put(freshnessKey("nodeB"), "clean");

            await db.put("nodeC", { value: 30 });
            await db.put(freshnessKey("nodeC"), "potentially-dirty");

            await db.put("nodeD", { value: 40 });
            await db.put(freshnessKey("nodeD"), "potentially-dirty");

            await db.put("nodeE", { value: 50 });
            await db.put(freshnessKey("nodeE"), "potentially-dirty");

            const graphDef = [
                {
                    output: "input1",
                    inputs: [],
                    computor: (inputs, oldValue) => oldValue || { value: 1 },
                },
                {
                    output: "input2",
                    inputs: [],
                    computor: (inputs, oldValue) => oldValue || { value: 2 },
                },
                {
                    output: "nodeA",
                    inputs: ["input1"],
                    computor: (inputs) => {
                        computeCalls.push("nodeA");
                        return { value: inputs[0].value * 10 };
                    },
                },
                {
                    output: "nodeB",
                    inputs: ["input2"],
                    computor: (inputs) => {
                        computeCalls.push("nodeB");
                        return { value: inputs[0].value * 10 };
                    },
                },
                {
                    output: "nodeC",
                    inputs: ["nodeA", "nodeB"],
                    computor: (inputs) => {
                        computeCalls.push("nodeC");
                        return { value: inputs[0].value + inputs[1].value };
                    },
                },
                {
                    output: "nodeD",
                    inputs: ["nodeC"],
                    computor: (inputs) => {
                        computeCalls.push("nodeD");
                        return { value: inputs[0].value * 2 };
                    },
                },
                {
                    output: "nodeE",
                    inputs: ["nodeC"],
                    computor: (inputs) => {
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
            await db.put(freshnessKey("input"), "dirty");

            await db.put("middle", { value: 10 });
            await db.put(freshnessKey("middle"), "potentially-dirty");

            await db.put("output", { value: 20 });
            await db.put(freshnessKey("output"), "potentially-dirty");

            const graphDef = [
                {
                    output: "input",
                    inputs: [],
                    computor: (inputs, oldValue) => oldValue || { value: 1 },
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
            expect(inputFreshness).toBe("clean");
            expect(middleFreshness).toBe("clean");
            expect(outputFreshness).toBe("clean");

            await db.close();
        });

        test("recomputes when dependencies are potentially-dirty", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);
            const { freshnessKey } = require("../src/generators/database");

            await db.put("input1", { data: "new_data" });
            await db.put(freshnessKey("input1"), "potentially-dirty");

            await db.put("output1", { data: "old_result" });
            await db.put(freshnessKey("output1"), "clean");

            const graphDef = [
                {
                    output: "input1",
                    inputs: [],
                    computor: (inputs, oldValue) =>
                        oldValue || { data: "new_data" },
                },
                {
                    output: "output1",
                    inputs: ["input1"],
                    computor: (inputs) => {
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
            expect(input1Freshness).toBe("clean");
            expect(output1Freshness).toBe("clean");

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
});
