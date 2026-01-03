/**
 * Integration test for DependencyGraph with meta_events generator.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { getRootDatabase } = require("../src/generators/database");
const {
    makeDependencyGraph,
    isUnchanged,
} = require("../src/generators/dependency_graph");
const {
    computeMetaEvents,
} = require("../src/generators/individual/meta_events");
const eventId = require("../src/event/id");
const { getMockedRootCapabilities } = require("./spies");
const { makeTestDatabase, freshnessKey } = require("./test_database_helper");
const { stubLogger } = require("./stubs");

/**
 * Creates test capabilities with a temporary data directory.
 */
function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "graph-integration-test-")
    );

    stubLogger(capabilities);

    capabilities.environment = {
        pathToVolodyslavDataDirectory: jest.fn().mockReturnValue(tmpDir),
    };

    return { ...capabilities, tmpDir };
}

describe("DependencyGraph integration with meta_events", () => {
    test("pull() fetches meta_events after updating all_events", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);

        // Define the graph - need to include all_events as a node
        const graphDefinition = [
            {
                output: "all_events",
                inputs: [],
                computor: (inputs, oldValue, _bindings) => 
                    oldValue || { type: "all_events", events: [] },
            },
            {
                output: "meta_events",
                inputs: ["all_events"],
                computor: (inputs, oldValue, _bindings) => {
                    const allEventsEntry = inputs[0];
                    if (!allEventsEntry) {
                        return { type: "meta_events", meta_events: [] };
                    }

                    const allEvents = allEventsEntry.events;
                    
                    // If no previous value, compute from scratch
                    if (!oldValue) {
                        const result = computeMetaEvents(allEvents, []);
                        // computeMetaEvents should never return Unchanged when previous is empty
                        // But handle it defensively
                        if (isUnchanged(result)) {
                            return { type: "meta_events", meta_events: [] };
                        }
                        return {
                            type: "meta_events",
                            meta_events: result,
                        };
                    }

                    const currentMetaEvents = oldValue.meta_events;
                    const result = computeMetaEvents(
                        allEvents,
                        currentMetaEvents
                    );

                    if (isUnchanged(result)) {
                        return result;
                    }

                    return {
                        type: "meta_events",
                        meta_events: result,
                    };
                },
            },
        ];

        const graph = makeDependencyGraph(db, graphDefinition);

            const testDb = makeTestDatabase(graph);
        // Add initial events - set directly on the graph
        await graph.set("all_events", {
            type: "all_events",
            events: [
                {
                    id: eventId.fromString("1"),
                    type: "test",
                    description: "Event 1",
                    date: "2024-01-01",
                    original: "test1",
                    input: "test1",
                    modifiers: {},
                    creator: { type: "user", name: "test" },
                },
                {
                    id: eventId.fromString("2"),
                    type: "test",
                    description: "Event 2",
                    date: "2024-01-02",
                    original: "test2",
                    input: "test2",
                    modifiers: {},
                    creator: { type: "user", name: "test" },
                },
            ],
        });

        // Pull meta_events
        const metaEventsEntry = await graph.pull("meta_events");

        // Check meta_events
        expect(metaEventsEntry).toBeDefined();
        expect(metaEventsEntry.meta_events).toHaveLength(2);
        expect(metaEventsEntry.meta_events[0].action).toBe("add");
        expect(eventId.toString(metaEventsEntry.meta_events[0].event.id)).toBe(
            "1"
        );
        expect(metaEventsEntry.meta_events[1].action).toBe("add");
        expect(eventId.toString(metaEventsEntry.meta_events[1].event.id)).toBe(
            "2"
        );

        await db.close();
    });
});
