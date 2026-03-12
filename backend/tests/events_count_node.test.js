/**
 * Tests for the `events_count` incremental-graph node and the
 * `getEventsCount()` method on InterfaceClass.
 *
 * Nodes / methods under test
 * ──────────────────────────
 *   events_count          – cached integer count of all events; O(1) read.
 *   interface.getEventsCount() – public wrapper around the events_count node.
 */

const {
    getTestCapabilities,
    writeEventsAndUpdate,
    makeSequentialEvents,
} = require("./sorted_events_test_helpers");

// ─── events_count graph node ──────────────────────────────────────────────────

describe("events_count graph node", () => {
    test("returns 0 for an empty event log", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const result = await iface._incrementalGraph.pull("events_count");
        expect(result.type).toBe("events_count");
        expect(result.count).toBe(0);
    });

    test("returns the correct count after adding events", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        await writeEventsAndUpdate(capabilities, makeSequentialEvents(7));

        const result = await iface._incrementalGraph.pull("events_count");
        expect(result.count).toBe(7);
    });

    test("is consistent with the length of all_events.events", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const events = makeSequentialEvents(15);
        await writeEventsAndUpdate(capabilities, events);

        const allResult = await iface._incrementalGraph.pull("all_events");
        const countResult = await iface._incrementalGraph.pull("events_count");
        expect(countResult.count).toBe(allResult.events.length);
    });
});

// ─── interface.getEventsCount() ───────────────────────────────────────────────

describe("interface.getEventsCount()", () => {
    test("returns 0 for an empty event log", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        expect(await iface.getEventsCount()).toBe(0);
    });

    test("returns the correct count after writing events", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        await writeEventsAndUpdate(capabilities, makeSequentialEvents(42));

        expect(await iface.getEventsCount()).toBe(42);
    });

    test("updates when new events are added in a second batch", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        await writeEventsAndUpdate(capabilities, makeSequentialEvents(3));
        expect(await iface.getEventsCount()).toBe(3);

        // Add more events with dates after the first batch
        await writeEventsAndUpdate(capabilities, makeSequentialEvents(2, "2025-01-01T00:00:00.000Z"));
        expect(await iface.getEventsCount()).toBe(5);
    });
});
