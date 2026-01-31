/**
 * Tests for reverse dependency indexing during invalidate.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { getRootDatabase } = require("../src/generators/incremental_graph/database");
const { makeIncrementalGraph } = require("../src/generators/incremental_graph");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger } = require("./stubs");
const { toJsonKey } = require("./test_json_key_helper");

/**
 * @typedef {import('../src/generators/incremental_graph/database/types').DatabaseCapabilities} DatabaseCapabilities
 */

/**
 * Creates test capabilities with a temporary data directory.
 * @returns {DatabaseCapabilities & { tmpDir: string }}
 */
function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "incremental-graph-invalidate-revdeps-")
    );

    stubLogger(capabilities);

    capabilities.environment = {
        pathToVolodyslavDataDirectory: jest.fn().mockReturnValue(tmpDir),
    };

    return { ...capabilities, tmpDir };
}

describe("incremental_graph invalidate reverse deps", () => {
    test("invalidate indexes reverse dependencies for materialized nodes", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);

        const graphDef = [
            {
                output: "source",
                inputs: [],
                computor: async () => ({ type: "all_events", events: [] }),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "derived",
                inputs: ["source"],
                computor: async () => ({ type: "meta_events", meta_events: [] }),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ];

        const graph = makeIncrementalGraph(db, graphDef);

        await graph.invalidate("derived");

        const storage = graph.getStorage();
        const sourceKey = toJsonKey("source");
        const derivedKey = toJsonKey("derived");

        const dependents = await storage.revdeps.get(sourceKey);
        expect(dependents).toEqual([derivedKey]);

        await db.close();
    });
});
