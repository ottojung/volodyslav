/**
 * Tests for bound variables in computors.
 * These tests verify that:
 * 1. pull() accepts a bindings parameter
 * 2. Computors receive the correct bindings
 * 3. Node identity includes bindings (different bindings = different instances)
 * 4. Invalidation works correctly with parameterized nodes
 * 5. Persistence works with parameterized nodes
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { getRootDatabase } = require("../src/generators/database");
const { makeDependencyGraph } = require("../src/generators/dependency_graph");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger } = require("./stubs");

/**
 * Creates test capabilities with a temporary data directory.
 */
function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "bindings-test-")
    );

    stubLogger(capabilities);

    capabilities.environment = {
        pathToVolodyslavDataDirectory: jest.fn().mockReturnValue(tmpDir),
    };

    return { ...capabilities, tmpDir };
}

describe("Bound variables in computors", () => {
    describe("API: pull(nodeName, bindings)", () => {
        test("pull accepts bindings parameter", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const schemas = [
                {
                    output: "source",
                    inputs: [],
                    computor: () => ({ value: 42 }),
                },
                {
                    output: "derived(x)",
                    inputs: ["source"],
                    computor: (inputs, oldValue, bindings) => {
                        // Computor should receive bindings with x
                        return { value: inputs[0].value, x: bindings.x };
                    },
                },
            ];

            const graph = makeDependencyGraph(db, schemas);

            // Set source value
            await graph.set("source", { value: 42 });

            // Pull with bindings
            const result = await graph.pull("derived(x)", { x: "test" });

            expect(result).toEqual({ value: 42, x: "test" });

            await db.close();
        });

        test("different bindings create different node instances", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const computorCallLog = [];

            const schemas = [
                {
                    output: "source",
                    inputs: [],
                    computor: () => ({ value: 1 }),
                },
                {
                    output: "derived(x)",
                    inputs: ["source"],
                    computor: (inputs, oldValue, bindings) => {
                        computorCallLog.push({ x: bindings.x });
                        return { value: inputs[0].value, x: bindings.x };
                    },
                },
            ];

            const graph = makeDependencyGraph(db, schemas);
            await graph.set("source", { value: 1 });

            // Pull with different bindings - should compute each separately
            const result1 = await graph.pull("derived(x)", { x: "first" });
            const result2 = await graph.pull("derived(x)", { x: "second" });

            expect(result1).toEqual({ value: 1, x: "first" });
            expect(result2).toEqual({ value: 1, x: "second" });

            // Should have computed both instances
            expect(computorCallLog).toHaveLength(2);
            expect(computorCallLog[0]).toEqual({ x: "first" });
            expect(computorCallLog[1]).toEqual({ x: "second" });

            await db.close();
        });

        test("same bindings use cached result", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const computorCallLog = [];

            const schemas = [
                {
                    output: "source",
                    inputs: [],
                    computor: () => ({ value: 1 }),
                },
                {
                    output: "derived(x)",
                    inputs: ["source"],
                    computor: (inputs, oldValue, bindings) => {
                        computorCallLog.push({ x: bindings.x });
                        return { value: inputs[0].value, x: bindings.x };
                    },
                },
            ];

            const graph = makeDependencyGraph(db, schemas);
            await graph.set("source", { value: 1 });

            // Pull same bindings twice
            const result1 = await graph.pull("derived(x)", { x: "test" });
            const result2 = await graph.pull("derived(x)", { x: "test" });

            expect(result1).toEqual({ value: 1, x: "test" });
            expect(result2).toEqual({ value: 1, x: "test" });

            // Should only compute once (second is cached)
            expect(computorCallLog).toHaveLength(1);

            await db.close();
        });
    });

    describe("Invalidation with parameterized nodes", () => {
        test("invalidation only affects matching binding instances", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const computorCallLog = [];

            const schemas = [
                {
                    output: "source",
                    inputs: [],
                    computor: () => ({ value: 1 }),
                },
                {
                    output: "derived(x)",
                    inputs: ["source"],
                    computor: (inputs, oldValue, bindings) => {
                        computorCallLog.push({ x: bindings.x, value: inputs[0].value });
                        return { value: inputs[0].value, x: bindings.x };
                    },
                },
            ];

            const graph = makeDependencyGraph(db, schemas);
            await graph.set("source", { value: 1 });

            // Pull with two different bindings
            await graph.pull("derived(x)", { x: "first" });
            await graph.pull("derived(x)", { x: "second" });

            expect(computorCallLog).toHaveLength(2);
            computorCallLog.length = 0; // clear log

            // Update source - both should be invalidated
            await graph.set("source", { value: 2 });

            // Pull again - both should recompute
            const result1 = await graph.pull("derived(x)", { x: "first" });
            const result2 = await graph.pull("derived(x)", { x: "second" });

            expect(result1).toEqual({ value: 2, x: "first" });
            expect(result2).toEqual({ value: 2, x: "second" });

            expect(computorCallLog).toHaveLength(2);

            await db.close();
        });
    });

    describe("Persistence with parameterized nodes", () => {
        test("parameterized nodes persist and restore correctly", async () => {
            const capabilities = getTestCapabilities();
            const db1 = await getRootDatabase(capabilities);

            const schemas = [
                {
                    output: "source",
                    inputs: [],
                    computor: () => ({ value: 1 }),
                },
                {
                    output: "derived(x)",
                    inputs: ["source"],
                    computor: (inputs, oldValue, bindings) => {
                        return { value: inputs[0].value, x: bindings.x };
                    },
                },
            ];

            const graph1 = makeDependencyGraph(db1, schemas);
            await graph1.set("source", { value: 1 });

            // Materialize instances with different bindings
            await graph1.pull("derived(x)", { x: "first" });
            await graph1.pull("derived(x)", { x: "second" });

            await db1.close();

            // Reopen database
            const db2 = await getRootDatabase(capabilities);
            const graph2 = makeDependencyGraph(db2, schemas);

            // Pull should get cached values
            const result1 = await graph2.pull("derived(x)", { x: "first" });
            const result2 = await graph2.pull("derived(x)", { x: "second" });

            expect(result1).toEqual({ value: 1, x: "first" });
            expect(result2).toEqual({ value: 1, x: "second" });

            await db2.close();
        });
    });

    describe("Deep graphs with parameterization", () => {
        test("parameterization works in deep dependency chains", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const schemas = [
                {
                    output: "source",
                    inputs: [],
                    computor: () => ({ value: 10 }),
                },
                {
                    output: "middle(x)",
                    inputs: ["source"],
                    computor: (inputs, oldValue, bindings) => {
                        return { value: inputs[0].value * 2, x: bindings.x };
                    },
                },
                {
                    output: "final(x)",
                    inputs: ["middle(x)"],
                    computor: (inputs, oldValue, bindings) => {
                        return { value: inputs[0].value + 1, x: bindings.x };
                    },
                },
            ];

            const graph = makeDependencyGraph(db, schemas);
            await graph.set("source", { value: 10 });

            const result = await graph.pull("final(x)", { x: "deep" });

            expect(result).toEqual({ value: 21, x: "deep" });

            await db.close();
        });

        test("paratemerization of a K_{3,3,3} graph", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            function stringJoin(arr, sep = ", ") {
                return arr.reduce((acc, curr, index) => {
                    return acc + (index === 0 ? "" : sep) + curr;
                }, "");
            }

            const schemas = [
                {
                    output: "source",
                    inputs: [],
                    computor: () => ({ value: 1 }),
                },
                // Layer 1
                ...[1, 2, 3].map(i => ({
                    output: `layer1_${i}(x)`,
                    inputs: ["source"],
                    computor: (inputs, oldValue, bindings) => {
                        return { value: `l1_${i}(${inputs[0].value + i}, ${bindings.x})` };
                    },
                })),
                // Layer 2
                ...[1, 2, 3].map(i => ({
                    output: `layer2_${i}(x)`,
                    inputs: [ `layer1_1(x)`, `layer1_2(x)`, `layer1_3(x)` ],
                    computor: (inputs, oldValue, bindings) => {
                        const sum = stringJoin(inputs.map(input => input.value));
                        return { value: `l2_${i}(${sum}, ${bindings.x})` };
                    },
                })),
                // Layer 3
                ...[1, 2, 3].map(i => ({
                    output: `layer3_${i}(x)`,
                    inputs: [ `layer2_1(x)`, `layer2_2(x)`, `layer2_3(x)` ],
                    computor: (inputs, oldValue, bindings) => {
                        const sum = stringJoin(inputs.map(input => input.value));
                        return { value: `l3_${i}(${sum}, ${bindings.x})` };
                    },
                })),
            ];

            const graph = makeDependencyGraph(db, schemas);
            await graph.set("source", { value: 1 });

            // Pull one of the deepest nodes
            const result = await graph.pull("layer3_2(x)", { x: "7" });

            // Manually compute expected value
            expect(result).toEqual({ value: "l3_2(l2_1(l1_1(2, 7), l1_2(3, 7), l1_3(4, 7), 7), l2_2(l1_1(2, 7), l1_2(3, 7), l1_3(4, 7), 7), l2_3(l1_1(2, 7), l1_2(3, 7), l1_3(4, 7), 7), 7)" });

            await db.close();

        });

        test("a graph f(x, y) <- g(x) + h(y)", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const schemas = [
                {
                    output: "g(x)",
                    inputs: [],
                    computor: (inputs, oldValue, bindings) => {
                        return { value: `g(${bindings.x})` };
                    },
                },
                {
                    output: "h(y)",
                    inputs: [],
                    computor: (inputs, oldValue, bindings) => {
                        return { value: `h(${bindings.y})` };
                    },
                },
                {
                    output: "f(x, y)",
                    inputs: ["g(x)", "h(y)"],
                    computor: (inputs, oldValue, bindings) => {
                        return { value: `f(${inputs[0].value}, ${inputs[1].value})` };
                    },
                },
            ];

            const graph = makeDependencyGraph(db, schemas);

            // Pull f with specific bindings
            const result = await graph.pull("f(x, y)", { x: "A", y: "B" });

            expect(result).toEqual({ value: "f(g(A), h(B))" });

            await db.close();
        });

        test("a graph f(x, y, z) <- (g(x, z) <- k(x) <- s1) + (h(y) <- s2)", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);
            const schemas = [
                {
                    output: "s1",
                    inputs: [],
                    computor: () => ({ value: "s1" }),
                },
                {
                    output: "s2",
                    inputs: [],
                    computor: () => ({ value: "s2" }),
                },
                {
                    output: "k(x)",
                    inputs: ["s1"],
                    computor: (inputs, oldValue, bindings) => {
                        return { value: `k(${bindings.x}, ${inputs[0].value})` };
                    },
                },
                {
                    output: "g(x, z)",
                    inputs: ["k(x)"],
                    computor: (inputs, oldValue, bindings) => {
                        return { value: `g(${inputs[0].value}, ${bindings.z})` };
                    },
                },
                {
                    output: "h(y)",
                    inputs: ["s2"],
                    computor: (inputs, oldValue, bindings) => {
                        return { value: `h(${bindings.y}, ${inputs[0].value})` };
                    },
                },
                {
                    output: "f(x, y, z)",
                    inputs: ["g(x, z)", "h(y)"],
                    computor: (inputs, oldValue, bindings) => {
                        return { value: `f(${inputs[0].value}, ${inputs[1].value})` };
                    },
                },
            ];

            const graph = makeDependencyGraph(db, schemas);

            // Pull f with specific bindings
            const result = await graph.pull("f(x, y, z)", { x: "A", y: "B", z: "C" });

            expect(result).toEqual({ value: "f(g(k(A, s1), C), h(B, s2))" });

            await db.close();
        });
    });

    describe("Single computor invocation per pull", () => {
        test("pulling same parameterized node multiple times only computes once", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const computorCallLog = [];

            const schemas = [
                {
                    output: "source",
                    inputs: [],
                    computor: () => ({ value: 1 }),
                },
                {
                    output: "expensive(x)",
                    inputs: ["source"],
                    computor: (inputs, oldValue, bindings) => {
                        computorCallLog.push({ x: bindings.x });
                        return { value: inputs[0].value, x: bindings.x };
                    },
                },
                {
                    output: "consumer1(x)",
                    inputs: ["expensive(x)"],
                    computor: (inputs, _oldValue, _bindings) => {
                        return { from: "consumer1", data: inputs[0] };
                    },
                },
                {
                    output: "consumer2(x)",
                    inputs: ["expensive(x)"],
                    computor: (inputs, _oldValue, _bindings) => {
                        return { from: "consumer2", data: inputs[0] };
                    },
                },
                {
                    output: "top(x)",
                    inputs: ["consumer1(x)", "consumer2(x)"],
                    computor: (inputs, _oldValue, _bindings) => {
                        return { c1: inputs[0], c2: inputs[1] };
                    },
                },
            ];

            const graph = makeDependencyGraph(db, schemas);
            await graph.set("source", { value: 1 });

            // Pull top - should compute expensive only once even though two consumers depend on it
            await graph.pull("top(x)", { x: "shared" });

            // expensive(x) should only be computed once
            expect(computorCallLog).toHaveLength(1);
            expect(computorCallLog[0]).toEqual({ x: "shared" });

            await db.close();
        });
    });
});
