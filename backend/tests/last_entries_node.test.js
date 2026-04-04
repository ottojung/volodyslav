/**
 * Tests for the `last_entries(n)` incremental-graph node.
 *
 * Node under test
 * ───────────────
 *   last_entries(n) – first `n` events of `sorted_events_descending`
 *   (most-recent n events).  Pulled with n = SORTED_EVENTS_CACHE_SIZE
 *   by the getSortedEvents() iterator for the fast first-page path.
 */

const { fromISOString } = require("../src/datetime");
const { SORTED_EVENTS_CACHE_SIZE } = require("../src/generators/interface/constants");
const {
    getTestCapabilities,
    makeEvent,
    writeEventsAndUpdate,
    makeSequentialEvents,
} = require("./sorted_events_test_helpers");

// ─── last_entries(n) ──────────────────────────────────────────────────────────

describe("last_entries(n) graph node", () => {
    test("contains the first SORTED_EVENTS_CACHE_SIZE events of descending order", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const events = [
            makeEvent("e1", "2024-01-01T00:00:00.000Z"),
            makeEvent("e2", "2024-02-01T00:00:00.000Z"),
            makeEvent("e3", "2024-03-01T00:00:00.000Z"),
        ];
        await writeEventsAndUpdate(capabilities, events);

        const descResult = await iface._incrementalGraph.pull("sorted_events_descending");
        const cacheResult = await iface._incrementalGraph.pull("last_entries", {n: SORTED_EVENTS_CACHE_SIZE});

        // Should be the same as the full descending list when count < cache size
        expect(cacheResult.type).toBe("last_entries");
        expect(cacheResult.n).toBe(SORTED_EVENTS_CACHE_SIZE);
        expect(cacheResult.events.map((e) => e.id)).toEqual(
            descResult.events.slice(0, SORTED_EVENTS_CACHE_SIZE).map((e) => e.id)
        );
    });

    test("returns empty array when no events exist", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const result = await iface._incrementalGraph.pull("last_entries", {n: SORTED_EVENTS_CACHE_SIZE});
        expect(result.type).toBe("last_entries");
        expect(result.n).toBe(SORTED_EVENTS_CACHE_SIZE);
        expect(result.events).toHaveLength(0);
    });

    test("caps at exactly n events even when more exist", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const events = makeSequentialEvents(SORTED_EVENTS_CACHE_SIZE + 10);
        await writeEventsAndUpdate(capabilities, events);

        const result = await iface._incrementalGraph.pull("last_entries", {n: SORTED_EVENTS_CACHE_SIZE});
        expect(result.events).toHaveLength(SORTED_EVENTS_CACHE_SIZE);
    });

    test("contains exactly n events when count equals n", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const events = makeSequentialEvents(SORTED_EVENTS_CACHE_SIZE);
        await writeEventsAndUpdate(capabilities, events);

        const result = await iface._incrementalGraph.pull("last_entries", {n: SORTED_EVENTS_CACHE_SIZE});
        expect(result.events).toHaveLength(SORTED_EVENTS_CACHE_SIZE);
    });

    test("events are in descending date order", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const events = makeSequentialEvents(5);
        await writeEventsAndUpdate(capabilities, events);

        const result = await iface._incrementalGraph.pull("last_entries", {n: SORTED_EVENTS_CACHE_SIZE});
        const dates = result.events.map((e) => fromISOString(e.date));
        for (let i = 1; i < dates.length; i++) {
            expect(dates[i - 1].isAfterOrEqual(dates[i])).toBe(true);
        }
    });

    test("smaller n returns only the first n events", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        await writeEventsAndUpdate(capabilities, makeSequentialEvents(10));

        const result = await iface._incrementalGraph.pull("last_entries", {n: 3});
        expect(result.type).toBe("last_entries");
        expect(result.n).toBe(3);
        expect(result.events).toHaveLength(3);
    });
});
