/**
 * Tests for bound variables with DatabaseValue objects (not just primitives).
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { getRootDatabase } = require("../src/generators/incremental_graph/database");
const { makeIncrementalGraph } = require("../src/generators/incremental_graph");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger, stubEnvironment } = require("./stubs");

/**
 * Creates test capabilities with a temporary data directory.
 */
function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "bindings-objects-test-")
    );

    stubLogger(capabilities);
    stubEnvironment(capabilities);
    return { ...capabilities, tmpDir };
}

describe("Bound variables with DatabaseValue objects", () => {
    test("pull accepts object bindings", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);

        const schemas = [
            {
                output: "source",
                inputs: [],
                computor: () => ({ type: "all_events", events: [] }),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "derived(x)",
                inputs: ["source"],
                computor: (inputs, _oldValue, bindings) => {
                    // bindings[0] should be a full DatabaseValue object
                    return {
                        type: "meta_events",
                        meta_events: [],
                        boundTo: bindings[0],
                    };
                },
                isDeterministic: true,
                hasSideEffects: false,
            },
        ];

        const graph = makeIncrementalGraph(db, schemas);

        // Invalidate source value
        await graph.invalidate("source");

        // Pull with object binding
        const objectBinding = { type: "all_events", events: [{ id: "test" }] };
        const result = await graph.pull("derived", [objectBinding]);

        expect(result).toEqual({
            type: "meta_events",
            meta_events: [],
            boundTo: objectBinding,
        });

        await db.close();
    });

    test("different object bindings create different instances", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);

        const computorCallLog = [];

        const schemas = [
            {
                output: "source",
                inputs: [],
                computor: () => ({ type: "all_events", events: [] }),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "derived(x)",
                inputs: ["source"],
                computor: (inputs, _oldValue, bindings) => {
                    computorCallLog.push({ x: bindings[0] });
                    return {
                        type: "meta_events",
                        meta_events: [],
                        boundTo: bindings[0],
                    };
                },
                isDeterministic: true,
                hasSideEffects: false,
            },
        ];

        const graph = makeIncrementalGraph(db, schemas);
        await graph.invalidate("source");

        // Pull with different object bindings
        const binding1 = { type: "all_events", events: [{ id: "first" }] };
        const binding2 = { type: "all_events", events: [{ id: "second" }] };

        const result1 = await graph.pull("derived", [binding1]);
        const result2 = await graph.pull("derived", [binding2]);

        expect(result1.boundTo).toEqual(binding1);
        expect(result2.boundTo).toEqual(binding2);

        // Should have computed both instances
        expect(computorCallLog).toHaveLength(2);

        await db.close();
    });

    test("same object bindings use cached result", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);

        const computorCallLog = [];

        const schemas = [
            {
                output: "source",
                inputs: [],
                computor: () => ({ type: "all_events", events: [] }),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "derived(x)",
                inputs: ["source"],
                computor: (inputs, _oldValue, bindings) => {
                    computorCallLog.push({ x: bindings[0] });
                    return {
                        type: "meta_events",
                        meta_events: [],
                        boundTo: bindings[0],
                    };
                },
                isDeterministic: true,
                hasSideEffects: false,
            },
        ];

        const graph = makeIncrementalGraph(db, schemas);
        await graph.invalidate("source");

        const binding = { type: "all_events", events: [{ id: "test" }] };

        // Pull same bindings twice
        const result1 = await graph.pull("derived", [binding]);
        const result2 = await graph.pull("derived", [binding]);

        expect(result1).toEqual(result2);

        // Should only compute once (second is cached)
        expect(computorCallLog).toHaveLength(1);

        await db.close();
    });
});
