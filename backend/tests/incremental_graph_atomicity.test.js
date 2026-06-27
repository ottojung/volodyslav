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

describe("incremental_graph atomicity without external batches", () => {
    test("dependency writes remain committed when parent recomputation fails", async () => {
        let sourceComputations = 0;
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);
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

        await expect(graph.pull("derived")).rejects.toThrow("derived-fails");
        // source WAS computed (as a dependency of derived)
        expect(sourceComputations).toBe(1);
        // In the new design, each pull creates its own Transaction.
        // source's pull (triggered by derived's computation) committed independently,
        // so source IS committed to disk even though derived's computor threw.
        expect(await graph.getFreshness("source")).toBe("up-to-date");
        // pulling source directly returns its already-committed value
        expect(await graph.pull("source")).toEqual({
            type: "all_events",
            events: [],
        });
        expect(sourceComputations).toBe(1);

        await db.close();
    });
});
