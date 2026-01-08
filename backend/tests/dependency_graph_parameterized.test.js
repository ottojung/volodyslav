/**
 * Integration tests for parameterized node schemas in DependencyGraph.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { getRootDatabase } = require("../src/generators/dependency_graph/database");
const {
    makeDependencyGraph,
    isInvalidNode,
    isSchemaPatternNotAllowed,
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
    describe("Error cases", () => {
        test("throws on schema pattern operation", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const schemas = [
                {
                    output: "derived(x)",
                    inputs: [],
                    computor: () => ({ value: 1 }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeDependencyGraph(db, schemas);

            // Try to pull with an identifier that looks like a pattern
            // In the new API, "derived(x)" is a schema pattern with variables
            // The public API rejects schema patterns, throwing SchemaPatternNotAllowedError
            await expect(graph.pull('derived(x)')).rejects.toThrow();

            let error = null;
            try {
                await graph.pull('derived(x)');
            } catch (err) {
                error = err;
            }
            expect(error).not.toBeNull();
            expect(isSchemaPatternNotAllowed(error)).toBe(true);

            // Try to set with an identifier that looks like a pattern
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
            const db = await getRootDatabase(capabilities);

            const graph = makeDependencyGraph(db, []);


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

    describe("Schema overlap detection (T3)", () => {
        test("rejects truly overlapping schemas", () => {
            // These truly overlap: pair(x,y) and pair(a,b) can match pair(1,2)
            const overlappingSchemas = [
                {
                    output: "pair(x,y)",
                    inputs: [],
                    computor: () => ({ type: "pair1" }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "pair(a,b)",
                    inputs: [],
                    computor: () => ({ type: "pair2" }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            expect(() => {
                const db = {};  // Dummy - won't be used
                makeDependencyGraph(db, overlappingSchemas);
            }).toThrow("Schema patterns overlap");
        });
    });

});
