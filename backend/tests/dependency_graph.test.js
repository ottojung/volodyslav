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
