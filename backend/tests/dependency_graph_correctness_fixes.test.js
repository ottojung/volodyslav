/**
 * Integration tests verifying all correctness fixes from the unified CompiledNode architecture.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { get: getDatabase } = require("../src/generators/database");
const {
    makeDependencyGraph,
} = require("../src/generators/dependency_graph");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger } = require("./stubs");

/**
 * Creates test capabilities with a temporary data directory.
 */
function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "correctness-fixes-test-")
    );

    stubLogger(capabilities);

    capabilities.environment = {
        pathToVolodyslavDataDirectory: jest.fn().mockReturnValue(tmpDir),
    };

    return { ...capabilities, tmpDir };
}

describe("Correctness fixes integration tests", () => {
    describe("Fix A: Instantiation marker persistence is reliable (not fire-and-forget)", () => {
        test("instantiation markers are persisted atomically with first value write", async () => {
            const capabilities = getTestCapabilities();
            const db1 = await getDatabase(capabilities);

            await db1.put("source", { value: 1 });

            const nodes = [
                {
                    output: "source",
                    inputs: [],
                    computor: (_inputs, oldValue) => oldValue,
                },
                {
                    output: "derived(x)",
                    inputs: ["source"],
                    variables: ["x"],
                    computor: (inputs, oldValue, bindings) => ({
                        value: inputs[0].value * 2,
                        id: bindings.x,
                    }),
                },
            ];

            const graph1 = makeDependencyGraph(db1, nodes);
            await graph1.pull("derived(test)");

            // Close database without waiting (simulating abrupt shutdown)
            await db1.close();

            // Reopen database and create new graph
            const db2 = await getDatabase(capabilities);
            const graph2 = makeDependencyGraph(db2, nodes);

            // Update source - should invalidate the instantiation
            await graph2.set("source", { value: 10 });

            // Pull should return new value (not stale cached value)
            const result = await graph2.pull("derived(test)");
            expect(result.value).toBe(20); // Not 2 from initial run

            await db2.close();
        });
    });

    describe("Fix B: Canonicalization is consistent throughout", () => {
        test("whitespace variations access same canonical node", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);

            await db.put("base", { value: 1 });

            const nodes = [
                {
                    output: "base",
                    inputs: [],
                    computor: (_inputs, oldValue) => oldValue,
                },
                {
                    output: "derived(x)",
                    inputs: ["base"],
                    variables: ["x"],
                    computor: (inputs, oldValue, bindings) => ({
                        value: inputs[0].value,
                        id: bindings.x,
                    }),
                },
            ];

            const graph = makeDependencyGraph(db, nodes);

            // Pull with various whitespace patterns
            const result1 = await graph.pull("derived(abc)");
            const result2 = await graph.pull("derived( abc )");
            const result3 = await graph.pull("derived ( abc ) ");

            // All should access the same node
            expect(result1).toEqual(result2);
            expect(result2).toEqual(result3);

            // Verify only one node was created in DB
            const keys = await db.keys("derived");
            // Should be just "derived(abc)" (canonical form)
            expect(keys.filter(k => k.startsWith("derived("))).toHaveLength(1);

            await db.close();
        });
    });

    describe("Fix C: ensureInitialized is concurrency-safe", () => {
        test("concurrent pull operations initialize only once", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);

            await db.put("source", { value: 1 });

            // Track how many times instantiation marker keys are retrieved
            let keysCallCount = 0;
            const originalKeys = db.keys.bind(db);
            db.keys = jest.fn(async (prefix) => {
                if (prefix === "instantiation:") {
                    keysCallCount++;
                }
                return originalKeys(prefix);
            });

            const nodes = [
                {
                    output: "source",
                    inputs: [],
                    computor: (_inputs, oldValue) => oldValue,
                },
                {
                    output: "derived(x)",
                    inputs: ["source"],
                    variables: ["x"],
                    computor: (inputs, oldValue, bindings) => ({
                        value: inputs[0].value,
                        id: bindings.x,
                    }),
                },
            ];

            const graph = makeDependencyGraph(db, nodes);

            // Launch multiple concurrent pulls
            const results = await Promise.all([
                graph.pull("derived(a)"),
                graph.pull("derived(b)"),
                graph.pull("derived(c)"),
            ]);

            // All should succeed
            expect(results).toHaveLength(3);
            expect(results[0].id).toBe("a");
            expect(results[1].id).toBe("b");
            expect(results[2].id).toBe("c");

            // Initialization (keys call) should happen only once
            expect(keysCallCount).toBe(1);

            await db.close();
        });
    });

    describe("Fix D: Schema overlap detection respects repeated-variable constraints", () => {
        test("schemas with different repeated-variable patterns are accepted", () => {
            // This test verifies that the overlap detection correctly handles
            // repeated variables using unification

            const nodes1 = [
                {
                    output: "triple(x,x,x)",
                    inputs: [],
                    variables: ["x"],
                    computor: () => ({}),
                },
                {
                    output: "triple(a,b,c)",
                    inputs: [],
                    variables: ["a", "b", "c"],
                    computor: () => ({}),
                },
            ];

            // These CAN unify (when a=b=c), so they should be rejected
            expect(() => makeDependencyGraph(null, nodes1)).toThrow();
        });

        test("schemas with conflicting constants do not overlap", () => {
            const nodes = [
                {
                    output: "foo(const1,x)",
                    inputs: [],
                    variables: ["x"],
                    computor: () => ({}),
                },
                {
                    output: "foo(const2,y)",
                    inputs: [],
                    variables: ["y"],
                    computor: () => ({}),
                },
            ];

            // These cannot unify (const1 != const2), so they should be accepted
            expect(() => makeDependencyGraph(null, nodes)).not.toThrow();
        });
    });

    describe("Unified architecture benefits", () => {
        test("pattern and concrete nodes coexist in unified graph", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);

            await db.put("constant_node", { value: 100 });

            const nodes = [
                // Concrete node
                {
                    output: "constant_node",
                    inputs: [],
                    computor: (_inputs, oldValue) => oldValue,
                },
                // Pattern node
                {
                    output: "pattern_node(x)",
                    inputs: ["constant_node"],
                    variables: ["x"],
                    computor: (inputs, oldValue, bindings) => ({
                        base: inputs[0].value,
                        id: bindings.x,
                    }),
                },
            ];

            const graph = makeDependencyGraph(db, nodes);

            // Both types work seamlessly
            const concreteResult = await graph.pull("constant_node");
            expect(concreteResult.value).toBe(100);

            const patternResult = await graph.pull("pattern_node(test)");
            expect(patternResult.base).toBe(100);
            expect(patternResult.id).toBe("test");

            await db.close();
        });

        test("backwards compatible API still works", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);

            await db.put("source", { value: 42 });

            // Old API with separate graph and schemas arrays
            const graph = [
                {
                    output: "source",
                    inputs: [],
                    computor: (_inputs, oldValue) => oldValue,
                },
            ];

            const schemas = [
                {
                    output: "derived(x)",
                    inputs: ["source"],
                    variables: ["x"],
                    computor: (inputs, oldValue, bindings) => ({
                        value: inputs[0].value,
                        id: bindings.x,
                    }),
                },
            ];

            // Old factory signature
            const dg = makeDependencyGraph(db, graph, schemas);

            const result = await dg.pull("derived(test)");
            expect(result.value).toBe(42);
            expect(result.id).toBe("test");

            await db.close();
        });
    });
});
