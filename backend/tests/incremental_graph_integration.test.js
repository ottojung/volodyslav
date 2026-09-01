/**
 * Integration test for IncrementalGraph with meta_events generator.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { getRootDatabase } = require("../src/generators/incremental_graph/database");
const {
    createIncrementalGraph,
} = require("../src/generators/incremental_graph");
const { metaEvents } = require("../src/generators/individual");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger, stubEnvironment } = require("./stubs");

/**
 * Creates test capabilities with a temporary data directory.
 */
function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "graph-integration-test-")
    );

    stubLogger(capabilities);
    stubEnvironment(capabilities);
    return { ...capabilities, tmpDir };
}

describe("IncrementalGraph integration with meta_events", () => {
    test("pull() fetches meta_events after updating all_events", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);

        // Define the graph - need to include all_events as a node
        const testEvents = [
            {
                id: "1",
                type: "test",
                description: "Event 1",
                date: "2024-01-01",
                original: "test1",
                input: "test1",
                modifiers: {},
                creator: { name: "test", uuid: "00000000-0000-0000-0000-000000000001", version: "0.0.0" },
            },
            {
                id: "2",
                type: "test",
                description: "Event 2",
                date: "2024-01-02",
                original: "test2",
                input: "test2",
                modifiers: {},
                creator: { name: "test", uuid: "00000000-0000-0000-0000-000000000002", version: "0.0.0" },
            },
        ];

        const graphDefinition = [
            {
                output: "all_events",
                inputs: [],
                computor: (_inputs, _oldValue, _bindings) => ({
                    type: "all_events",
                    events: testEvents,
                }),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "meta_events",
                inputs: ["all_events"],
                computor: metaEvents.computor,
                isDeterministic: true,
                hasSideEffects: false,
            },
        ];

        const graph = await createIncrementalGraph(capabilities, db, graphDefinition);

        // Invalidate all_events to trigger computation
        await graph.invalidate("all_events");

        // Pull meta_events
        const metaEventsEntry = await graph.pull("meta_events");

        // Check meta_events
        expect(metaEventsEntry).toBeDefined();
        expect(metaEventsEntry.meta_events).toHaveLength(2);
        expect(metaEventsEntry.meta_events[0].action).toBe("add");
        expect(metaEventsEntry.meta_events[0].event.id).toBe("1");
        expect(metaEventsEntry.meta_events[1].action).toBe("add");
        expect(metaEventsEntry.meta_events[1].event.id).toBe("2");

        await db.close();
    });
});
