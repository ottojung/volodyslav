const path = require("path");
const fs = require("fs");
const os = require("os");
const { getRootDatabase } = require("../src/generators/incremental_graph/database");
const { createIncrementalGraph } = require("../src/generators/incremental_graph");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger, stubEnvironment } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    fs.mkdtempSync(path.join(os.tmpdir(), "incremental-graph-atomicity-"));
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    return capabilities;
}

/**
 * A graph transition publishes as one durable write, so a pull whose computor
 * throws publishes nothing: the dependency it computed on the way is volatile
 * state only and is recomputed by the next pull.
 *
 * Pinned here because the shape is observable only through the public API and
 * through the count of durable writes the storage is asked to issue.
 */
describe("a failed graph transition publishes nothing", () => {
    test("a failed parent leaves its dependency unmaterialized", async () => {
        let sourceComputations = 0;
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);

        const schemaStorage = db.getSchemaStorage();
        const originalBatch = schemaStorage.batch.bind(schemaStorage);
        let durableWrites = 0;
        schemaStorage.batch = async (operations) => {
            durableWrites++;
            await originalBatch(operations);
        };

        const graph = await createIncrementalGraph(capabilities, db, [
            {
                output: "source",
                inputs: [],
                computor: async () => {
                    sourceComputations++;
                    return { type: "all_events", events: [] };
                },
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "derived",
                inputs: ["source"],
                computor: async () => {
                    throw new Error("derived-fails");
                },
                isDeterministic: true,
                hasSideEffects: false,
            },
        ]);

        // The graph writes its scheme and version when it is created on a fresh
        // database; only writes issued by the pull itself are of interest here.
        const writesBeforePull = durableWrites;

        try {
            await expect(graph.pull("derived")).rejects.toThrow("derived-fails");

            // source WAS computed (as a dependency of derived), so the failure
            // happened after the dependency was staged rather than before it.
            expect(sourceComputations).toBe(1);
            // The computor runs before the serialized finalization boundary, so
            // nothing it produced is durable yet.
            expect(durableWrites).toBe(writesBeforePull);
            expect(await graph.getFreshness("source")).toBeUndefined();
            expect(await graph.getFreshness("derived")).toBeUndefined();

            // The next pull recomputes source, which is what it must do if the
            // failed publication left no value for it.
            await expect(graph.pull("source")).resolves.toEqual({
                type: "all_events",
                events: [],
            });
            expect(sourceComputations).toBe(2);
            expect(await graph.getFreshness("source")).toBe("up-to-date");
        } finally {
            schemaStorage.batch = originalBatch;
            await db.close();
        }
    });
});
