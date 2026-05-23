const path = require("path");
const fs = require("fs");
const os = require("os");
const { getRootDatabase } = require("../src/generators/incremental_graph/database");
const { makeIncrementalGraph } = require("../src/generators/incremental_graph");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger, stubEnvironment } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    fs.mkdtempSync(path.join(os.tmpdir(), "incremental-graph-atomicity-"));
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    return capabilities;
}

describe("incremental_graph atomicity without external batches", () => {
    test("dependency writes are rolled back when derived computation fails (all-or-nothing atomicity)", async () => {
        let sourceComputations = 0;
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);
        const graph = makeIncrementalGraph(capabilities, db, [
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

        await expect(graph.pull("derived")).rejects.toThrow("derived-fails");
        // source WAS computed (as a dependency of derived)
        expect(sourceComputations).toBe(1);
        // source's write is rolled back because it shares the batch with derived;
        // all-or-nothing atomicity means if derived fails, source is not committed either
        expect(await graph.getFreshness("source")).toBe("missing");
        // pulling source directly causes it to be recomputed and committed
        expect(await graph.pull("source")).toEqual({
            type: "all_events",
            events: [],
        });
        expect(sourceComputations).toBe(2);

        await db.close();
    });
});
