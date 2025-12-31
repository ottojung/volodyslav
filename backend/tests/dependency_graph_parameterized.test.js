/**
 * Integration tests for parameterized node schemas in DependencyGraph.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { get: getDatabase } = require("../src/generators/database");
const {
    makeDependencyGraph,
    makeUnchanged,
    isSchemaPatternNotAllowed,
    isInvalidNode,
} = require("../src/generators/dependency_graph");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger } = require("./stubs");

/**
 * Creates test capabilities with a temporary data directory.
 */
function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "parameterized-graph-test-")
    );

    stubLogger(capabilities);

    capabilities.environment = {
        pathToVolodyslavDataDirectory: jest.fn().mockReturnValue(tmpDir),
    };

    return { ...capabilities, tmpDir };
}

describe("Parameterized node schemas", () => {
    describe("Basic instantiation", () => {
        test("pull creates concrete instantiation from schema", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);

            // Set up base data
            await db.put("all_events", {
                type: "all_events",
                events: [
                    { id: "id123", description: "Event 123" },
                    { id: "id456", description: "Event 456" },
                ],
            });

            // Define schema
            const schemas = [
                {
                    output: "event_context(e)",
                    inputs: ["all_events"],
                    computor: (inputs, oldValue, bindings) => {
                        const allEvents = inputs[0].events;
                        const event = allEvents.find(
                            (ev) => ev.id === bindings.e.value
                        );
                        return {
                            type: "event_context",
                            eventId: bindings.e.value,
                            context: event
                                ? `Context for ${event.description}`
                                : "Not found",
                        };
                    },
                },
            ];

            const graph = makeDependencyGraph(db, schemas);

            // Pull concrete instantiation
            const result = await graph.pull('event_context("id123")');

            expect(result).toEqual({
                type: "event_context",
                eventId: "id123",
                context: "Context for Event 123",
            });

            // Verify it was stored
            const stored = await db.getValue('event_context("id123")');
            expect(stored).toEqual(result);

            await db.close();
        });

        test("caching works for instantiations", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);

            await db.put("base", { value: 1 });

            let computeCount = 0;
            const schemas = [
                {
                    output: "derived(x)",
                    inputs: ["base"],
                    computor: (inputs, oldValue, bindings) => {
                        computeCount++;
                        return {
                            value: inputs[0].value * 2,
                            id: bindings.x.value,
                        };
                    },
                },
            ];

            const graph = makeDependencyGraph(db, schemas);

            // First pull - should compute
            const result1 = await graph.pull('derived("abc")');
            expect(computeCount).toBe(1);
            expect(result1.value).toBe(2);

            // Second pull - should use cache
            const result2 = await graph.pull('derived("abc")');
            expect(computeCount).toBe(1); // No recomputation
            expect(result2).toEqual(result1);

            await db.close();
        });
    });

    describe("Invalidation", () => {
        test("invalidation reaches demanded instantiation", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);

            await db.put("source", { count: 1 });

            const schemas = [
                {
                    output: "derived(x)",
                    inputs: ["source"],
                    computor: (inputs, oldValue, bindings) => ({
                        count: inputs[0].count + 1,
                        id: bindings.x.value,
                    }),
                },
            ];

            const graph = makeDependencyGraph(db, schemas);

            // Pull instantiation
            const result1 = await graph.pull('derived("test1")');
            expect(result1.count).toBe(2);

            // Update source
            await graph.set("source", { count: 10 });

            // Pull again - should recompute
            const result2 = await graph.pull('derived("test1")');
            expect(result2.count).toBe(11);

            await db.close();
        });

        test("only demanded instantiations are tracked", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);

            await db.put("source", { value: 1 });

            const schemas = [
                {
                    output: "derived(x)",
                    inputs: ["source"],
                    computor: (inputs, oldValue, bindings) => ({
                        value: inputs[0].value,
                        id: bindings.x.value,
                    }),
                },
            ];

            const graph = makeDependencyGraph(db, schemas);

            // Demand only one instantiation
            await graph.pull('derived("demanded")');

            // Update source
            await graph.set("source", { value: 2 });

            // The demanded one should be invalidated
            const demandedFreshness = await db.getFreshness(
                "freshness(derived(\"demanded\"))"
            );
            expect(demandedFreshness).toBe("potentially-outdated");

            // Non-demanded instantiations shouldn't exist in DB
            const nonDemandedFreshness = await db.getFreshness(
                "freshness(derived(\"not_demanded\"))"
            );
            expect(nonDemandedFreshness).toBeUndefined();

            await db.close();
        });
    });

    describe("Restart resilience", () => {
        test("previously demanded instantiations are invalidated after restart", async () => {
            const capabilities = getTestCapabilities();
            const db1 = await getDatabase(capabilities);

            await db1.put("source", { value: 1 });

            const schemas = [
                {
                    output: "derived(x)",
                    inputs: ["source"],
                    computor: (inputs, oldValue, bindings) => ({
                        value: inputs[0].value * 2,
                        id: bindings.x.value,
                    }),
                },
            ];

            // Instance A: demand instantiation
            const graph1 = makeDependencyGraph(db1, schemas);
            await graph1.pull('derived("persistent")');

            await db1.close();

            // Instance B: new graph with same database
            const db2 = await getDatabase(capabilities);
            const graph2 = makeDependencyGraph(db2, schemas);

            // Update source - this should invalidate the previously demanded instantiation
            await graph2.set("source", { value: 10 });

            // Pull should recompute with new value
            const result = await graph2.pull('derived("persistent")');
            expect(result.value).toBe(20);

            await db2.close();
        });
    });

    describe("Multiple variables", () => {
        test("schema with multiple variables", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);

            await db.put("events", { events: ["e1", "e2"] });
            await db.put("photos", { photos: ["p1", "p2"] });

            const schemas = [
                {
                    output: "enhanced_event(e,p)",
                    inputs: ["events", "photos"],
                    computor: (inputs, oldValue, bindings) => ({
                        event: bindings.e.value,
                        photo: bindings.p.value,
                        combined: `${bindings.e.value}_${bindings.p.value}`,
                    }),
                },
            ];

            const graph = makeDependencyGraph(db, schemas);

            const result = await graph.pull('enhanced_event("e1","p2")');
            expect(result).toEqual({
                event: "e1",
                photo: "p2",
                combined: "e1_p2",
            });

            await db.close();
        });
    });

    describe("Unchanged propagation", () => {
        test("Unchanged works for instantiations", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);

            await db.put("source", { value: 1 });

            let computeCount = 0;
            const schemas = [
                {
                    output: "middle(x)",
                    inputs: ["source"],
                    computor: (inputs, oldValue, bindings) => {
                        computeCount++;
                        if (
                            oldValue &&
                            oldValue.value === inputs[0].value
                        ) {
                            return makeUnchanged();
                        }
                        return {
                            value: inputs[0].value,
                            id: bindings.x.value,
                        };
                    },
                },
                {
                    output: "final(x)",
                    inputs: ["middle(x)"],
                    computor: (inputs, oldValue, bindings) => {
                        computeCount++;
                        return {
                            value: inputs[0].value * 2,
                            id: bindings.x.value,
                        };
                    },
                },
            ];

            const graph = makeDependencyGraph(db, schemas);

            // Initial pull
            await graph.pull('final("test")');

            // Update source with same value - middle should return Unchanged
            await graph.set("source", { value: 1 });

            computeCount = 0;
            // Pull final again - middle returns Unchanged, final shouldn't recompute
            await graph.pull('final("test")');
            expect(computeCount).toBe(1); // Only middle computed, not final

            await db.close();
        });
    });

    describe("Error cases", () => {
        test("throws on schema pattern operation", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);

            const schemas = [
                {
                    output: "derived(x)",
                    inputs: [],
                    computor: () => ({ value: 1 }),
                },
            ];

            const graph = makeDependencyGraph(db, schemas);

            // Try to pull schema pattern directly
            await expect(graph.pull('derived(x)')).rejects.toThrow();

            let error = null;
            try {
                await graph.pull('derived(x)');
            } catch (err) {
                error = err;
            }
            expect(error).not.toBeNull();
            expect(isSchemaPatternNotAllowed(error)).toBe(true);

            // Try to set schema pattern directly
            await expect(
                graph.set("derived(x)", { value: 1 })
            ).rejects.toThrow();

            error = null;
            try {
                await graph.set("derived(x)", { value: 1 });
            } catch (err) {
                error = err;
            }
            expect(error).not.toBeNull();
            expect(isSchemaPatternNotAllowed(error)).toBe(true);

            await db.close();
        });

        test("throws on unknown node", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);

            const graph = makeDependencyGraph(db, []);

            await expect(graph.pull("unknown_node")).rejects.toThrow();

            let error = null;
            try {
                await graph.pull("unknown_node");
            } catch (err) {
                error = err;
            }
            expect(error).not.toBeNull();
            expect(isInvalidNode(error)).toBe(true);

            await db.close();
        });
    });

    describe("Whitespace handling", () => {
        test("handles whitespace in node names", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);

            await db.put("base", { value: 1 });

            const schemas = [
                {
                    output: "derived(x)",
                    inputs: ["base"],
                    computor: (inputs, oldValue, bindings) => ({
                        value: inputs[0].value,
                        id: bindings.x.value,
                    }),
                },
            ];

            const graph = makeDependencyGraph(db, schemas);

            // Pull with whitespace in string literal
            const result1 = await graph.pull('derived(" abc ")');
            expect(result1.id).toBe(" abc ");

            // Pull with different string literal - creates new instance
            const result2 = await graph.pull('derived("abc")');
            expect(result2.id).toBe("abc");
            expect(result2).not.toEqual(result1);

            await db.close();
        });
    });

    describe("Schema overlap detection (T3)", () => {
        test("rejects truly overlapping schemas", () => {
            const capabilities = getTestCapabilities();
            
            // These truly overlap: pair(x,y) and pair(a,b) can match pair(1,2)
            const overlappingSchemas = [
                {
                    output: "pair(x,y)",
                    inputs: [],
                    computor: () => ({ type: "pair1" }),
                },
                {
                    output: "pair(a,b)",
                    inputs: [],
                    computor: () => ({ type: "pair2" }),
                },
            ];

            expect(() => {
                const db = {};  // Dummy - won't be used
                makeDependencyGraph(db, overlappingSchemas);
            }).toThrow("Overlaps");
        });

        test("accepts non-overlapping schemas with repeated variables", async () => {
            const capabilities = getTestCapabilities();
            const db = await getDatabase(capabilities);

            await db.put("base", { value: 1 });

            // These DON'T overlap: pair(x,x) requires both args equal,
            // pair(a,b) where a != b has different args
            // But they can both exist because they match different concrete keys
            const nonOverlappingSchemas = [
                {
                    output: "pair(x,x)",
                    inputs: ["base"],
                    computor: (inputs, oldValue, bindings) => ({
                        type: "same_pair",
                        value: bindings.x.value,
                    }),
                },
                {
                    output: 'pair("a","b")',
                    inputs: ["base"],
                    computor: (inputs) => ({
                        type: "different_pair",
                        value: inputs[0].value,
                    }),
                },
            ];

            // Should not throw
            const graph = makeDependencyGraph(db, nonOverlappingSchemas);

            // pair(x,x) matches pair(1,1) but not pair(1,2)
            const result1 = await graph.pull('pair(1,1)');
            expect(result1.type).toBe("same_pair");

            // pair("a","b") matches exactly
            const result2 = await graph.pull('pair("a","b")');
            expect(result2.type).toBe("different_pair");

            await db.close();
        });

        test("rejects overlapping schemas due to constant mismatch", () => {
            const capabilities = getTestCapabilities();
            
            // These DON'T overlap: different constants
            const schemas = [
                {
                    output: 'pair("x","y")',
                    inputs: [],
                    computor: () => ({ type: "pair1" }),
                },
                {
                    output: 'pair("a","b")',
                    inputs: [],
                    computor: () => ({ type: "pair2" }),
                },
            ];

            // Should not throw
            const db = {}; // Dummy
            expect(() => makeDependencyGraph(db, schemas)).not.toThrow();
        });
    });
});
