/**
 * Integration tests for parameterized schema functionality in DependencyGraph.
 * Tests demand-driven instantiation, caching, invalidation, and restart resilience.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { get: getDatabase } = require("../src/generators/database");
const { makeDependencyGraph } = require("../src/generators/dependency_graph");
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
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-db-"));
    
    // Stub logger to avoid console output during tests
    stubLogger(capabilities);
    
    // Override environment to use temp directory
    capabilities.environment = {
        pathToVolodyslavDataDirectory: jest.fn().mockReturnValue(tmpDir),
    };
    
    return { ...capabilities, tmpDir };
}

describe("generators/dependency_graph with schemas", () => {
    describe("Basic parameterized schema functionality", () => {
        test("pull on concrete instantiation creates node on-demand", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);
            
            // Define a parameterized schema: event_context(e) depends on raw_event(e)
            const schemas = [
                {
                    output: "event_context(e)",
                    variables: ["e"],
                    inputs: ["raw_event(e)"],
                    computor: (inputs, _oldValue, _bindings) => {
                        const rawEvent = inputs[0];
                        return { event: rawEvent, context: "added" };
                    }
                }
            ];

            // Static graph with a constant node
            const graph = [
                {
                    output: "raw_event(id123)",
                    inputs: [],
                    computor: () => ({ id: "id123", data: "test" })
                }
            ];

            const dg = makeDependencyGraph(db, graph, schemas);

            // Pull a concrete instantiation - should create it on-demand
            const result = await dg.pull("event_context(id123)");
            
            expect(result).toEqual({
                event: { id: "id123", data: "test" },
                context: "added"
            });

            // Verify instantiation marker was persisted
            const marker = await db.get("instantiation:event_context(id123)");
            expect(marker).toBe(1);
            
            // Cleanup
            await db.close();
            fs.rmSync(capabilities.tmpDir, { recursive: true, force: true });
        });

        test("second pull uses cached value (fast path)", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);
            let computorCallCount = 0;

            const schemas = [
                {
                    output: "cached_node(x)",
                    variables: ["x"],
                    inputs: [],
                    computor: (inputs, oldValue, bindings) => {
                        computorCallCount++;
                        return { value: `computed_${bindings.x}` };
                    }
                }
            ];

            const dg = makeDependencyGraph(db, [], schemas);

            // First pull - should compute
            const result1 = await dg.pull("cached_node(abc)");
            expect(result1).toEqual({ value: "computed_abc" });
            expect(computorCallCount).toBe(1);

            // Second pull - should use cache
            const result2 = await dg.pull("cached_node(abc)");
            expect(result2).toEqual({ value: "computed_abc" });
            expect(computorCallCount).toBe(1); // Not called again
            
            // Cleanup
            await db.close();
            fs.rmSync(capabilities.tmpDir, { recursive: true, force: true });
        });

        test("pulling different instantiations creates separate nodes", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);
            const computorCalls = [];

            const schemas = [
                {
                    output: "node(x)",
                    variables: ["x"],
                    inputs: [],
                    computor: (inputs, oldValue, bindings) => {
                        computorCalls.push(bindings.x);
                        return { value: `value_${bindings.x}` };
                    }
                }
            ];

            const dg = makeDependencyGraph(db, [], schemas);

            const result1 = await dg.pull("node(a)");
            const result2 = await dg.pull("node(b)");
            const result3 = await dg.pull("node(c)");

            expect(result1).toEqual({ value: "value_a" });
            expect(result2).toEqual({ value: "value_b" });
            expect(result3).toEqual({ value: "value_c" });
            expect(computorCalls).toEqual(["a", "b", "c"]);
            
            // Cleanup
            await db.close();
            fs.rmSync(capabilities.tmpDir, { recursive: true, force: true });
        });
    });

    describe("Schema pattern rejection", () => {
        test("pulling a schema pattern throws error", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);
            
            const schemas = [
                {
                    output: "event_context(e)",
                    variables: ["e"],
                    inputs: [],
                    computor: () => ({})
                }
            ];

            const dg = makeDependencyGraph(db, [], schemas);

            let errorThrown = false;
            try {
                await dg.pull("event_context(e)");
            } catch (error) {
                errorThrown = true;
            }
            expect(errorThrown).toBe(true);
            
            // Cleanup
            await db.close();
            fs.rmSync(capabilities.tmpDir, { recursive: true, force: true });
        });

        test("setting a schema pattern throws error", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);
            
            const schemas = [
                {
                    output: "some_pattern(x)",
                    variables: ["x"],
                    inputs: [],
                    computor: () => ({})
                }
            ];

            const dg = makeDependencyGraph(db, [], schemas);

            let errorThrown = false;
            try {
                await dg.set("some_pattern(x)", {});
            } catch (error) {
                errorThrown = true;
            }
            expect(errorThrown).toBe(true);
            
            // Cleanup
            await db.close();
            fs.rmSync(capabilities.tmpDir, { recursive: true, force: true });
        });
    });

    describe("Invalidation with parameterized nodes", () => {
        test("setting upstream node invalidates concrete instantiation", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);
            let computorCallCount = 0;

            const graph = [
                {
                    output: "all_events",
                    inputs: [],
                    computor: () => []
                }
            ];

            const schemas = [
                {
                    output: "event_context(e)",
                    variables: ["e"],
                    inputs: ["all_events"],
                    computor: (inputs, oldValue, bindings) => {
                        computorCallCount++;
                        const events = inputs[0];
                        return { event: bindings.e, count: events.length };
                    }
                }
            ];

            const dg = makeDependencyGraph(db, graph, schemas);

            // Initial pull
            const result1 = await dg.pull("event_context(id1)");
            expect(result1).toEqual({ event: "id1", count: 0 });
            expect(computorCallCount).toBe(1);

            // Set upstream node
            await dg.set("all_events", [1, 2, 3]);

            // Pull again - should recompute due to invalidation
            const result2 = await dg.pull("event_context(id1)");
            expect(result2).toEqual({ event: "id1", count: 3 });
            expect(computorCallCount).toBe(2); // Recomputed
            
            // Cleanup
            await db.close();
            fs.rmSync(capabilities.tmpDir, { recursive: true, force: true });
        });

        test("invalidation only affects instantiations with matching dependencies", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);
            const computorCalls = [];

            const graph = [
                {
                    output: "source_a",
                    inputs: [],
                    computor: () => ({ val: "a" })
                },
                {
                    output: "source_b",
                    inputs: [],
                    computor: () => ({ val: "b" })
                }
            ];

            const schemas = [
                {
                    output: "derived(x,src)",
                    variables: ["x", "src"],
                    inputs: ["source_a", "source_b"],
                    computor: (inputs, oldValue, bindings) => {
                        computorCalls.push({ x: bindings.x, src: bindings.src });
                        const a = inputs[0].val;
                        const b = inputs[1].val;
                        return { result: `${bindings.x}_${a}_${b}` };
                    }
                }
            ];

            const dg = makeDependencyGraph(db, graph, schemas);

            // Create two instantiations
            await dg.pull("derived(1,a)");
            await dg.pull("derived(2,b)");
            expect(computorCalls.length).toBe(2);

            // Invalidate source_a
            computorCalls.length = 0;
            await dg.set("source_a", { val: "new_a" });

            // Both instantiations depend on source_a, so both should recompute
            await dg.pull("derived(1,a)");
            await dg.pull("derived(2,b)");
            expect(computorCalls.length).toBe(2);
            
            // Cleanup
            await db.close();
            fs.rmSync(capabilities.tmpDir, { recursive: true, force: true });
        });
    });

    describe("Restart resilience", () => {
        test("new instance loads instantiations from database", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);
            let computorCallCount = 0;

            const schemas = [
                {
                    output: "persistent(x)",
                    variables: ["x"],
                    inputs: [],
                    computor: (inputs, oldValue, bindings) => {
                        computorCallCount++;
                        return { value: `value_${bindings.x}` };
                    }
                }
            ];

            // First instance - create some instantiations
            const dg1 = makeDependencyGraph(db, [], schemas);
            await dg1.pull("persistent(a)");
            await dg1.pull("persistent(b)");
            expect(computorCallCount).toBe(2);

            // Create second instance (simulates restart)
            const dg2 = makeDependencyGraph(db, [], schemas);
            
            // Pull should use cached values, not recompute
            const result1 = await dg2.pull("persistent(a)");
            const result2 = await dg2.pull("persistent(b)");
            
            expect(result1).toEqual({ value: "value_a" });
            expect(result2).toEqual({ value: "value_b" });
            expect(computorCallCount).toBe(2); // Still only 2, not 4
            
            // Cleanup
            await db.close();
            fs.rmSync(capabilities.tmpDir, { recursive: true, force: true });
        });

        test("invalidation across restart", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);
            let computorCallCount = 0;

            const graph = [
                {
                    output: "source",
                    inputs: [],
                    computor: () => ({ val: "initial" })
                }
            ];

            const schemas = [
                {
                    output: "dependent(x)",
                    variables: ["x"],
                    inputs: ["source"],
                    computor: (inputs, oldValue, bindings) => {
                        computorCallCount++;
                        const src = inputs[0].val;
                        return { result: `${bindings.x}_${src}` };
                    }
                }
            ];

            // First instance
            const dg1 = makeDependencyGraph(db, graph, schemas);
            const result1 = await dg1.pull("dependent(test)");
            expect(result1).toEqual({ result: "test_initial" });
            expect(computorCallCount).toBe(1);

            // Invalidate source
            await dg1.set("source", { val: "changed" });

            // Second instance (restart) - should detect invalidation
            const dg2 = makeDependencyGraph(db, graph, schemas);
            const result2 = await dg2.pull("dependent(test)");
            expect(result2).toEqual({ result: "test_changed" });
            expect(computorCallCount).toBe(2); // Recomputed after restart
            
            // Cleanup
            await db.close();
            fs.rmSync(capabilities.tmpDir, { recursive: true, force: true });
        });
    });

    describe("Canonicalization", () => {
        test("keys with different whitespace are treated as same node", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);
            let computorCallCount = 0;

            const schemas = [
                {
                    output: "node(x,y)",
                    variables: ["x", "y"],
                    inputs: [],
                    computor: (inputs, oldValue, bindings) => {
                        computorCallCount++;
                        return { result: `${bindings.x}_${bindings.y}` };
                    }
                }
            ];

            const dg = makeDependencyGraph(db, [], schemas);

            // Pull with different whitespace variations
            const result1 = await dg.pull("node(a,b)");
            const result2 = await dg.pull("node(a, b)");
            const result3 = await dg.pull("node( a , b )");
            const result4 = await dg.pull("node(a,b)");

            expect(result1).toEqual({ result: "a_b" });
            expect(result2).toEqual({ result: "a_b" });
            expect(result3).toEqual({ result: "a_b" });
            expect(result4).toEqual({ result: "a_b" });
            
            // Should only compute once due to canonicalization
            expect(computorCallCount).toBe(1);
            
            // Cleanup
            await db.close();
            fs.rmSync(capabilities.tmpDir, { recursive: true, force: true });
        });

        test("set with non-canonical key stores under canonical form", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);

            const schemas = [
                {
                    output: "node(a,b)",
                    variables: ["a", "b"],
                    inputs: [],
                    computor: () => ({ default: true })
                }
            ];

            const dg = makeDependencyGraph(db, [], schemas);

            // Set with extra whitespace
            await dg.set("node( x , y )", { value: 42 });

            // Pull with canonical form
            const result = await dg.pull("node(x,y)");
            expect(result).toEqual({ value: 42 });
            
            // Cleanup
            await db.close();
            fs.rmSync(capabilities.tmpDir, { recursive: true, force: true });
        });
    });

    describe("Only demanded instantiations tracked", () => {
        test("only pulled/set instantiations have markers in database", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);

            const schemas = [
                {
                    output: "tracked(x)",
                    variables: ["x"],
                    inputs: [],
                    computor: (_inputs, _oldValue, bindings) => ({ value: `value_${bindings.x}` })
                }
            ];

            const dg = makeDependencyGraph(db, [], schemas);

            // Pull only specific instantiations
            await dg.pull("tracked(a)");
            await dg.pull("tracked(c)");

            // Check which markers exist
            const markerA = await db.get("instantiation:tracked(a)");
            const markerB = await db.get("instantiation:tracked(b)");
            const markerC = await db.get("instantiation:tracked(c)");

            expect(markerA).toBe(1);
            expect(markerB).toBe(undefined); // Not pulled, so no marker
            expect(markerC).toBe(1);
            
            // Cleanup
            await db.close();
            fs.rmSync(capabilities.tmpDir, { recursive: true, force: true });
        });

        test("setting a concrete node creates instantiation marker", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);

            const schemas = [
                {
                    output: "manual(x)",
                    variables: ["x"],
                    inputs: [],
                    computor: () => ({ error: "should not be called" })
                }
            ];

            const dg = makeDependencyGraph(db, [], schemas);

            // Set directly (not pull)
            await dg.set("manual(test)", { set: "directly" });

            // Check marker exists
            const marker = await db.get("instantiation:manual(test)");
            expect(marker).toBe(1);

            // Pull should return the set value, not compute
            const result = await dg.pull("manual(test)");
            expect(result).toEqual({ set: "directly" });
            
            // Cleanup
            await db.close();
            fs.rmSync(capabilities.tmpDir, { recursive: true, force: true });
        });
    });

    describe("Complex multi-parameter schemas", () => {
        test("schema with multiple parameters instantiates correctly", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);

            const schemas = [
                {
                    output: "complex(a,b,c)",
                    variables: ["a", "b", "c"],
                    inputs: [],
                    computor: (_inputs, _oldValue, _bindings) => ({
                        a: _bindings.a,
                        b: _bindings.b,
                        c: _bindings.c,
                        combined: `${_bindings.a}_${_bindings.b}_${_bindings.c}`
                    })
                }
            ];

            const dg = makeDependencyGraph(db, [], schemas);

            const result = await dg.pull("complex(x,y,z)");
            expect(result).toEqual({
                a: "x",
                b: "y",
                c: "z",
                combined: "x_y_z"
            });
            
            // Cleanup
            await db.close();
            fs.rmSync(capabilities.tmpDir, { recursive: true, force: true });
        });

        test("schema input dependencies are also instantiated", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);

            const schemas = [
                {
                    output: "base(x)",
                    variables: ["x"],
                    inputs: [],
                    computor: (inputs, oldValue, bindings) => ({ value: `base_${bindings.x}` })
                },
                {
                    output: "derived(x)",
                    variables: ["x"],
                    inputs: ["base(x)"],
                    computor: (inputs, _oldValue, _bindings) => {
                        const base = inputs[0].value;
                        return { value: `derived_${base}` };
                    }
                }
            ];

            const dg = makeDependencyGraph(db, [], schemas);

            const result = await dg.pull("derived(test)");
            expect(result).toEqual({ value: "derived_base_test" });

            // Verify both nodes have markers
            const baseMarker = await db.get("instantiation:base(test)");
            const derivedMarker = await db.get("instantiation:derived(test)");
            
            expect(baseMarker).toBe(1);
            expect(derivedMarker).toBe(1);
            
            // Cleanup
            await db.close();
            fs.rmSync(capabilities.tmpDir, { recursive: true, force: true });
        });
    });

    describe("Error handling", () => {
        test("computor error is propagated correctly", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);

            const schemas = [
                {
                    output: "failing(x)",
                    variables: ["x"],
                    inputs: [],
                    computor: (inputs, oldValue, bindings) => {
                        throw new Error(`Computation failed for ${bindings.x}`);
                    }
                }
            ];

            const dg = makeDependencyGraph(db, [], schemas);

            await expect(dg.pull("failing(test)")).rejects.toThrow(
                "Computation failed for test"
            );
            
            // Cleanup
            await db.close();
            fs.rmSync(capabilities.tmpDir, { recursive: true, force: true });
        });

        test("missing schema for concrete node throws error", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);

            // No schemas defined
            const dg = makeDependencyGraph(db, [], []);

            // Try to pull a parameterized node
            await expect(dg.pull("undefined_node(x)")).rejects.toThrow();
            
            // Cleanup
            await db.close();
            fs.rmSync(capabilities.tmpDir, { recursive: true, force: true });
        });
    });
});
