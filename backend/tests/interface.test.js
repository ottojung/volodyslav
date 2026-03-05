/**
 * Tests for generators/interface module.
 */

const {
    makeInterface,
    isInterface,
} = require("../src/generators/interface");
const eventId = require("../src/event/id");
const { fromISOString } = require("../src/datetime");
const { transaction } = require("../src/event_log_storage");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger, stubEnvironment, stubDatetime, stubEventLogRepository } = require("./stubs");

/**
 * @typedef {import('../src/generators/incremental_graph/database/types').DatabaseCapabilities} DatabaseCapabilities
 */

/**
 * Creates test capabilities.
 * @returns {Promise<object>}
 */
async function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    await stubEventLogRepository(capabilities);
    return capabilities;
}

/**
 * Builds a minimal well-formed event for testing.
 * @param {string} id
 * @param {string} input
 */
function makeEvent(id, input) {
    return {
        id: eventId.fromString(id),
        type: "text",
        description: input,
        date: fromISOString("2024-01-01T00:00:00.000Z"),
        original: input,
        input,
        modifiers: {},
        creator: { type: "user", name: "test" },
    };
}

/**
 * Writes events to the event log gitstore via a transaction.
 * @param {object} capabilities
 * @param {Array<object>} events
 */
async function writeEventsToStore(capabilities, events) {
    await transaction(capabilities, async (storage) => {
        for (const event of events) {
            storage.addEntry(event, []);
        }
    });
}

/**
 * Replaces an event in the event store by deleting the old one and adding the new one.
 * @param {object} capabilities
 * @param {object} event
 */
async function replaceEventInStore(capabilities, event) {
    await transaction(capabilities, async (storage) => {
        storage.deleteEntry(event.id);
        storage.addEntry(event, []);
    });
}

describe("generators/interface", () => {
    describe("makeInterface()", () => {
        test("creates and returns an interface instance", async () => {
            const capabilities = await getTestCapabilities();
            const iface = makeInterface(() => capabilities);
            await iface.ensureInitialized();
            expect(isInterface(iface)).toBe(true);
        });
    });

    describe("update()", () => {
        test("stores events in database under all_events key", async () => {
            const capabilities = await getTestCapabilities();
            const iface = makeInterface(() => capabilities);
            await iface.ensureInitialized();

            await writeEventsToStore(capabilities, [
                makeEvent("event-1", "First event"),
                makeEvent("event-2", "Second event"),
            ]);
            await iface.update();

            const result = await iface.incrementalGraph.pull("all_events");
            expect(result).toBeDefined();
            expect(result.events).toHaveLength(2);
            expect(result.events[0].id.identifier).toBe("event-1");
            expect(result.events[1].id.identifier).toBe("event-2");

            const freshness = await iface.incrementalGraph.debugGetFreshness("all_events");
            expect(freshness).toBe("up-to-date");
        });

        test("reflects the updated state after an event is replaced", async () => {
            const capabilities = await getTestCapabilities();
            const iface = makeInterface(() => capabilities);
            await iface.ensureInitialized();

            await writeEventsToStore(capabilities, [
                makeEvent("event-1", "original text"),
            ]);
            await iface.update();

            let result = await iface.incrementalGraph.pull("all_events");
            expect(result.events).toHaveLength(1);
            expect(result.events[0].id.identifier).toBe("event-1");

            // Replace event-1 with new content and add event-2
            await replaceEventInStore(capabilities, makeEvent("event-1", "updated text"));
            await writeEventsToStore(capabilities, [makeEvent("event-2", "new event")]);
            await iface.update();

            result = await iface.incrementalGraph.pull("all_events");
            expect(result.events).toHaveLength(2);
            const ids = result.events.map((e) => e.id.identifier);
            expect(ids).toContain("event-1");
            expect(ids).toContain("event-2");
            const e1 = result.events.find((e) => e.id.identifier === "event-1");
            expect(e1).toBeDefined();
            expect(e1.input).toBe("updated text");
        });

        test("handles empty store (returns no events)", async () => {
            const capabilities = await getTestCapabilities();
            const iface = makeInterface(() => capabilities);
            await iface.ensureInitialized();

            await iface.update();

            const result = await iface.incrementalGraph.pull("all_events");
            expect(result).toBeDefined();
            expect(result.events).toHaveLength(0);

            const freshness = await iface.incrementalGraph.debugGetFreshness("all_events");
            expect(freshness).toBe("up-to-date");
        });

        test("is a no-op before ensureInitialized()", async () => {
            const capabilities = await getTestCapabilities();
            const iface = makeInterface(() => capabilities);
            // Should not throw before initialization
            await expect(iface.update()).resolves.toBeUndefined();
        });
    });

    describe("getEventBasicContext()", () => {
        test("returns context for event with shared hashtags", async () => {
            const capabilities = await getTestCapabilities();
            const iface = makeInterface(() => capabilities);
            await iface.ensureInitialized();

            const events = [
                makeEvent("1", "First #project event"),
                makeEvent("2", "Second #project event"),
                makeEvent("3", "Unrelated #other event"),
            ];

            await writeEventsToStore(capabilities, events);
            await iface.update();

            // Get context for first event
            const context = await iface.getEventBasicContext(events[0]);

            // Should include both events with #project
            expect(context).toHaveLength(2);
            const contextIds = context.map((e) => e.id.identifier);
            expect(contextIds).toContain("1");
            expect(contextIds).toContain("2");
            expect(contextIds).not.toContain("3");
        });

        test("returns only the event itself when no shared hashtags", async () => {
            const capabilities = await getTestCapabilities();
            const iface = makeInterface(() => capabilities);
            await iface.ensureInitialized();

            const events = [makeEvent("1", "Event without hashtags")];

            await writeEventsToStore(capabilities, events);
            await iface.update();

            const context = await iface.getEventBasicContext(events[0]);

            expect(context).toHaveLength(1);
            expect(context[0].id.identifier).toBe("1");
        });

        test("propagates through incremental graph before returning context", async () => {
            const capabilities = await getTestCapabilities();
            const iface = makeInterface(() => capabilities);
            await iface.ensureInitialized();

            const events = [makeEvent("1", "Test #tag event")];

            await writeEventsToStore(capabilities, events);
            await iface.update();

            // Get context - this should trigger propagation
            const context = await iface.getEventBasicContext(events[0]);

            expect(context).toBeDefined();
            expect(context).toHaveLength(1);

            // Verify that event_context was computed in the incremental graph
            const eventContextEntry = await iface.incrementalGraph.pull("event_context");
            expect(eventContextEntry).toBeDefined();
            expect(eventContextEntry.type).toBe("event_context");
            expect(eventContextEntry.contexts).toHaveLength(1);
        });
    });

    describe("Type guards", () => {
        test("isInterface correctly identifies instances", async () => {
            const capabilities = await getTestCapabilities();
            const iface = makeInterface(() => capabilities);
            await iface.ensureInitialized();

            expect(isInterface(iface)).toBe(true);
            expect(isInterface({})).toBe(false);
            expect(isInterface(null)).toBe(false);
            expect(isInterface(undefined)).toBe(false);
        });
    });
});
