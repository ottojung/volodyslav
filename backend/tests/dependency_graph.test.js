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

/**
 * Cleanup function to remove temporary directories.
 * @param {string} tmpDir
 */
function cleanup(tmpDir) {
    if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

describe("generators/dependency_graph", () => {
    describe("makeDependencyGraph()", () => {
        test("creates and returns a dependency graph instance", async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getDatabase(capabilities);
                const graph = makeDependencyGraph(db, []);

                expect(isDependencyGraph(graph)).toBe(true);

                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });
    });

    describe("step()", () => {
        test("returns false when there are no dirty flags", async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getDatabase(capabilities);
                
                // Set up a clean input
                await db.put("input1", {
                    value: { data: "test" },
                    isDirty: false,
                });

                const graphDef = [
                    {
                        output: "output1",
                        inputs: ["input1"],
                        computor: (inputs) => {
                            return { data: inputs[0].value.data + "_processed" };
                        },
                    },
                ];

                const graph = makeDependencyGraph(db, graphDef);
                const result = await graph.step();

                expect(result).toBe(false);

                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test("propagates dirty flag from input to output", async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getDatabase(capabilities);
                
                // Set up a dirty input
                await db.put("input1", {
                    value: { data: "test" },
                    isDirty: true,
                });

                const graphDef = [
                    {
                        output: "output1",
                        inputs: ["input1"],
                        computor: (inputs) => {
                            return { data: inputs[0].value.data + "_processed" };
                        },
                    },
                ];

                const graph = makeDependencyGraph(db, graphDef);
                const result = await graph.step();

                expect(result).toBe(true);

                // Check the output was computed
                const output = await db.get("output1");
                expect(output).toBeDefined();
                expect(output.value.data).toBe("test_processed");
                expect(output.isDirty).toBe(true);

                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test("handles Unchanged return value", async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getDatabase(capabilities);
                
                // Set up a dirty input and existing output
                await db.put("input1", {
                    value: { data: "test" },
                    isDirty: true,
                });
                await db.put("output1", {
                    value: { data: "existing" },
                    isDirty: false,
                });

                const graphDef = [
                    {
                        output: "output1",
                        inputs: ["input1"],
                        computor: () => {
                            return makeUnchanged();
                        },
                    },
                ];

                const graph = makeDependencyGraph(db, graphDef);
                const result = await graph.step();

                expect(result).toBe(false);

                // Check the output remains unchanged and is marked clean
                const output = await db.get("output1");
                expect(output).toBeDefined();
                expect(output.value.data).toBe("existing");
                expect(output.isDirty).toBe(false);

                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test("processes multiple nodes in graph", async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getDatabase(capabilities);
                
                // Set up dirty inputs
                await db.put("input1", {
                    value: { data: "test1" },
                    isDirty: true,
                });
                await db.put("input2", {
                    value: { data: "test2" },
                    isDirty: true,
                });

                const graphDef = [
                    {
                        output: "output1",
                        inputs: ["input1"],
                        computor: (inputs) => {
                            return { data: inputs[0].value.data + "_out1" };
                        },
                    },
                    {
                        output: "output2",
                        inputs: ["input2"],
                        computor: (inputs) => {
                            return { data: inputs[0].value.data + "_out2" };
                        },
                    },
                ];

                const graph = makeDependencyGraph(db, graphDef);
                const result = await graph.step();

                expect(result).toBe(true);

                // Check both outputs were computed
                const output1 = await db.get("output1");
                expect(output1).toBeDefined();
                expect(output1.value.data).toBe("test1_out1");

                const output2 = await db.get("output2");
                expect(output2).toBeDefined();
                expect(output2.value.data).toBe("test2_out2");

                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test("uses old value in computor", async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getDatabase(capabilities);
                
                // Set up dirty input and existing output
                await db.put("input1", {
                    value: { count: 5 },
                    isDirty: true,
                });
                await db.put("output1", {
                    value: { total: 10 },
                    isDirty: false,
                });

                const graphDef = [
                    {
                        output: "output1",
                        inputs: ["input1"],
                        computor: (inputs, oldValue) => {
                            const inputCount = inputs[0].value.count;
                            const oldTotal = oldValue ? oldValue.value.total : 0;
                            return { total: oldTotal + inputCount };
                        },
                    },
                ];

                const graph = makeDependencyGraph(db, graphDef);
                const result = await graph.step();

                expect(result).toBe(true);

                // Check the output uses old value
                const output = await db.get("output1");
                expect(output).toBeDefined();
                expect(output.value.total).toBe(15); // 10 + 5

                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });
    });

    describe("run()", () => {
        test("propagates through multiple levels until fixpoint", async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getDatabase(capabilities);
                
                // Set up dirty input
                await db.put("input1", {
                    value: { count: 1 },
                    isDirty: true,
                });

                // Define a multi-level graph
                const graphDef = [
                    {
                        output: "level1",
                        inputs: ["input1"],
                        computor: (inputs) => {
                            return { count: inputs[0].value.count + 1 };
                        },
                    },
                    {
                        output: "level2",
                        inputs: ["level1"],
                        computor: (inputs) => {
                            return { count: inputs[0].value.count + 1 };
                        },
                    },
                    {
                        output: "level3",
                        inputs: ["level2"],
                        computor: (inputs) => {
                            return { count: inputs[0].value.count + 1 };
                        },
                    },
                ];

                const graph = makeDependencyGraph(db, graphDef);
                await graph.run();

                // Check all levels were computed
                const level1 = await db.get("level1");
                expect(level1).toBeDefined();
                expect(level1.value.count).toBe(2);

                const level2 = await db.get("level2");
                expect(level2).toBeDefined();
                expect(level2.value.count).toBe(3);

                const level3 = await db.get("level3");
                expect(level3).toBeDefined();
                expect(level3.value.count).toBe(4);

                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test("stops when no more dirty flags", async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getDatabase(capabilities);
                
                // Set up clean input
                await db.put("input1", {
                    value: { data: "test" },
                    isDirty: false,
                });

                const graphDef = [
                    {
                        output: "output1",
                        inputs: ["input1"],
                        computor: (inputs) => {
                            return { data: inputs[0].value.data + "_processed" };
                        },
                    },
                ];

                const graph = makeDependencyGraph(db, graphDef);
                await graph.run();

                // Output should not exist since input was not dirty
                const output = await db.get("output1");
                expect(output).toBeUndefined();

                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });
    });

    describe("pull()", () => {
        test("lazily evaluates only necessary nodes", async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getDatabase(capabilities);

                // Track which computors were called
                const computeCalls = [];

                // Set up a chain: input1 -> level1 -> level2 -> level3
                await db.put("input1", {
                    value: { count: 1 },
                    isDirty: true,
                });

                const graphDef = [
                    {
                        output: "level1",
                        inputs: ["input1"],
                        computor: (inputs) => {
                            computeCalls.push("level1");
                            return { count: inputs[0].value.count + 1 };
                        },
                    },
                    {
                        output: "level2",
                        inputs: ["level1"],
                        computor: (inputs) => {
                            computeCalls.push("level2");
                            return { count: inputs[0].value.count + 1 };
                        },
                    },
                    {
                        output: "level3",
                        inputs: ["level2"],
                        computor: (inputs) => {
                            computeCalls.push("level3");
                            return { count: inputs[0].value.count + 1 };
                        },
                    },
                ];

                const graph = makeDependencyGraph(db, graphDef);

                // Pull only level2 - should compute level1 and level2 but NOT level3
                const result = await graph.pull("level2");

                expect(result).toBeDefined();
                expect(result.value.count).toBe(3);
                expect(computeCalls).toEqual(["level1", "level2"]);

                // level3 should not have been computed
                const level3 = await db.get("level3");
                expect(level3).toBeUndefined();

                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test("returns cached value when dependencies are clean", async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getDatabase(capabilities);

                let computeCount = 0;

                await db.put("input1", {
                    value: { data: "test" },
                    isDirty: false, // Clean input
                });

                await db.put("output1", {
                    value: { data: "cached_result" },
                    isDirty: false, // Clean output
                });

                const graphDef = [
                    {
                        output: "output1",
                        inputs: ["input1"],
                        computor: (inputs) => {
                            computeCount++;
                            return { data: inputs[0].value.data + "_computed" };
                        },
                    },
                ];

                const graph = makeDependencyGraph(db, graphDef);
                const result = await graph.pull("output1");

                // Should return cached value without computing
                expect(result.value.data).toBe("cached_result");
                expect(computeCount).toBe(0);

                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test("recomputes when dependencies are dirty", async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getDatabase(capabilities);

                await db.put("input1", {
                    value: { data: "new_data" },
                    isDirty: true, // Dirty input
                });

                await db.put("output1", {
                    value: { data: "old_result" },
                    isDirty: false,
                });

                const graphDef = [
                    {
                        output: "output1",
                        inputs: ["input1"],
                        computor: (inputs) => {
                            return { data: inputs[0].value.data + "_processed" };
                        },
                    },
                ];

                const graph = makeDependencyGraph(db, graphDef);
                const result = await graph.pull("output1");

                // Should have recomputed with new input
                expect(result.value.data).toBe("new_data_processed");

                // Both input and output should now be clean
                const input1 = await db.get("input1");
                expect(input1.isDirty).toBe(false);
                expect(result.isDirty).toBe(false);

                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test("pulls non-graph nodes directly from database", async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getDatabase(capabilities);

                await db.put("standalone", {
                    value: { data: "standalone_value" },
                    isDirty: true,
                });

                const graph = makeDependencyGraph(db, []);
                const result = await graph.pull("standalone");

                expect(result).toBeDefined();
                expect(result.value.data).toBe("standalone_value");

                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test("handles Unchanged return value", async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getDatabase(capabilities);

                await db.put("input1", {
                    value: { data: "test" },
                    isDirty: true,
                });

                await db.put("output1", {
                    value: { data: "existing_value" },
                    isDirty: false,
                });

                const graphDef = [
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

                // Should keep existing value
                expect(result.value.data).toBe("existing_value");
                expect(result.isDirty).toBe(false);

                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });
    });

    describe("Type guards", () => {
        test("isDependencyGraph correctly identifies instances", async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getDatabase(capabilities);
                const graph = makeDependencyGraph(db, []);

                expect(isDependencyGraph(graph)).toBe(true);
                expect(isDependencyGraph({})).toBe(false);
                expect(isDependencyGraph(null)).toBe(false);
                expect(isDependencyGraph(undefined)).toBe(false);

                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });
    });
});
