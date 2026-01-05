/**
 * Tests for bound variables with DatabaseValue objects (not just primitives).
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
        path.join(os.tmpdir(), "bindings-objects-test-")
    );

    stubLogger(capabilities);

    capabilities.environment = {
        pathToVolodyslavDataDirectory: jest.fn().mockReturnValue(tmpDir),
    };

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
            },
        ];

        const graph = makeDependencyGraph(db, schemas);

        // Set source value
        await graph.set("source", { type: "all_events", events: [] });

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
            },
        ];

        const graph = makeDependencyGraph(db, schemas);
        await graph.set("source", { type: "all_events", events: [] });

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
            },
        ];

        const graph = makeDependencyGraph(db, schemas);
        await graph.set("source", { type: "all_events", events: [] });

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
