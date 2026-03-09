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
    test("dependency writes remain committed when derived recomputation fails", async () => {
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
        expect(sourceComputations).toBe(1);
        expect(await graph.debugGetFreshness("source")).toBe("up-to-date");
        expect(await graph.pull("source")).toEqual({
            type: "all_events",
            events: [],
        });
        expect(sourceComputations).toBe(1);

        await db.close();
    });
});
