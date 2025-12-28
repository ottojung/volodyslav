/**
 * Integration test for DependencyGraph with meta_events generator.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { get: getDatabase } = require("../src/generators/database");
const { makeInterface } = require("../src/generators/interface");
const { makeDependencyGraph, isUnchanged } = require("../src/generators/dependency_graph");
const { computeMetaEvents } = require("../src/generators/individual/meta_events");
const eventId = require("../src/event/id");
const { getMockedRootCapabilities } = require("./spies");
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

/**
 * Cleanup function to remove temporary directories.
 */
function cleanup(tmpDir) {
    if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

describe("DependencyGraph integration with meta_events", () => {
    test("propagates changes from all_events to meta_events", async () => {
        const capabilities = getTestCapabilities();
        try {
            const db = await getDatabase(capabilities);
            const iface = makeInterface(db);

            // Define the graph
            const graphDefinition = [
                {
                    output: "meta_events",
                    inputs: ["all_events"],
                    computor: (inputs, oldValue) => {
                        const allEventsEntry = inputs[0];
                        if (!allEventsEntry) {
                            return { type: "meta_events", meta_events: [] };
                        }

                        const allEvents = allEventsEntry.value.events;
                        const currentMetaEvents = oldValue 
                            ? oldValue.value.meta_events 
                            : [];

                        const result = computeMetaEvents(allEvents, currentMetaEvents);
                        
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

            // Step 1: Add initial events
            await iface.update([
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
            ]);

            // Propagate
            let propagated = await graph.step();
            expect(propagated).toBe(true);

            // Check meta_events
            let metaEventsEntry = await db.get("meta_events");
            expect(metaEventsEntry).toBeDefined();
            expect(metaEventsEntry.value.meta_events).toHaveLength(1);
            expect(metaEventsEntry.value.meta_events[0].action).toBe("add");
            expect(eventId.toString(metaEventsEntry.value.meta_events[0].event.id)).toBe("1");

            // Step 2: Add another event
            await iface.update([
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
            ]);

            // Propagate
            propagated = await graph.step();
            expect(propagated).toBe(true);

            // Check meta_events now has both
            metaEventsEntry = await db.get("meta_events");
            expect(metaEventsEntry).toBeDefined();
            expect(metaEventsEntry.value.meta_events).toHaveLength(2);

            await db.close();
        } finally {
            cleanup(capabilities.tmpDir);
        }
    });

    test("stops propagation when no changes occur", async () => {
        const capabilities = getTestCapabilities();
        try {
            const db = await getDatabase(capabilities);
            const iface = makeInterface(db);

            const graphDefinition = [
                {
                    output: "meta_events",
                    inputs: ["all_events"],
                    computor: (inputs, oldValue) => {
                        const allEventsEntry = inputs[0];
                        if (!allEventsEntry) {
                            return { type: "meta_events", meta_events: [] };
                        }

                        const allEvents = allEventsEntry.value.events;
                        const currentMetaEvents = oldValue 
                            ? oldValue.value.meta_events 
                            : [];

                        const result = computeMetaEvents(allEvents, currentMetaEvents);
                        
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

            // Add initial events
            await iface.update([
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
            ]);

            // First step propagates
            let propagated = await graph.step();
            expect(propagated).toBe(true);

            // Second step should not propagate (no more dirty flags)
            propagated = await graph.step();
            expect(propagated).toBe(false);

            await db.close();
        } finally {
            cleanup(capabilities.tmpDir);
        }
    });
});
