/**
 * Tests for the `first_entries(n)` incremental-graph node.
 *
 * Node under test
 * ───────────────
 *   first_entries(n) – first `n` events of `sorted_events_ascending`
 *   (oldest n events).  Mirrors last_entries(n) for the ascending-order
 *   case; pulled with n = SORTED_EVENTS_CACHE_SIZE by getSortedEvents().
 */

const { fromISOString } = require("../src/datetime");
const { SORTED_EVENTS_CACHE_SIZE } = require("../src/generators/interface/constants");
const {
    getTestCapabilities,
    makeEvent,
    writeEventsAndUpdate,
    makeSequentialEvents,
} = require("./sorted_events_test_helpers");

// ─── first_entries(n) ─────────────────────────────────────────────────────────

describe("first_entries(n) graph node", () => {
    test("contains the first SORTED_EVENTS_CACHE_SIZE events of ascending order", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const events = [
            makeEvent("e1", "2024-01-01T00:00:00.000Z"),
            makeEvent("e2", "2024-02-01T00:00:00.000Z"),
            makeEvent("e3", "2024-03-01T00:00:00.000Z"),
        ];
        await writeEventsAndUpdate(capabilities, events);

        const ascResult = await iface._incrementalGraph.pull("sorted_events_ascending");
        const cacheResult = await iface._incrementalGraph.pull("first_entries", [SORTED_EVENTS_CACHE_SIZE]);

        expect(cacheResult.type).toBe("first_entries");
        expect(cacheResult.n).toBe(SORTED_EVENTS_CACHE_SIZE);
        expect(cacheResult.events.map((e) => e.id)).toEqual(
            ascResult.events.slice(0, SORTED_EVENTS_CACHE_SIZE).map((e) => e.id)
        );
    });

    test("returns empty array when no events exist", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const result = await iface._incrementalGraph.pull("first_entries", [SORTED_EVENTS_CACHE_SIZE]);
        expect(result.type).toBe("first_entries");
        expect(result.n).toBe(SORTED_EVENTS_CACHE_SIZE);
        expect(result.events).toHaveLength(0);
    });

    test("caps at exactly n events even when more exist", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const events = makeSequentialEvents(SORTED_EVENTS_CACHE_SIZE + 10);
        await writeEventsAndUpdate(capabilities, events);

        const result = await iface._incrementalGraph.pull("first_entries", [SORTED_EVENTS_CACHE_SIZE]);
        expect(result.events).toHaveLength(SORTED_EVENTS_CACHE_SIZE);
    });

    test("contains exactly n events when count equals n", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const events = makeSequentialEvents(SORTED_EVENTS_CACHE_SIZE);
        await writeEventsAndUpdate(capabilities, events);

        const result = await iface._incrementalGraph.pull("first_entries", [SORTED_EVENTS_CACHE_SIZE]);
        expect(result.events).toHaveLength(SORTED_EVENTS_CACHE_SIZE);
    });

    test("events are in ascending date order", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const events = makeSequentialEvents(5);
        await writeEventsAndUpdate(capabilities, events);

        const result = await iface._incrementalGraph.pull("first_entries", [SORTED_EVENTS_CACHE_SIZE]);
        const dates = result.events.map((e) => fromISOString(e.date));
        for (let i = 1; i < dates.length; i++) {
            expect(dates[i - 1].isBeforeOrEqual(dates[i])).toBe(true);
        }
    });

    test("is the mirror of last_entries(n) for the same event set", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const events = makeSequentialEvents(10);
        await writeEventsAndUpdate(capabilities, events);

        const firstResult = await iface._incrementalGraph.pull("first_entries", [SORTED_EVENTS_CACHE_SIZE]);
        const lastResult = await iface._incrementalGraph.pull("last_entries", [SORTED_EVENTS_CACHE_SIZE]);

        // For ≤ SORTED_EVENTS_CACHE_SIZE events the two caches are reverses of
        // each other.
        expect(firstResult.events.map((e) => e.id)).toEqual(
            [...lastResult.events].reverse().map((e) => e.id)
        );
    });

    test("smaller n returns only the first n events", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        await writeEventsAndUpdate(capabilities, makeSequentialEvents(10));

        const result = await iface._incrementalGraph.pull("first_entries", [3]);
        expect(result.type).toBe("first_entries");
        expect(result.n).toBe(3);
        expect(result.events).toHaveLength(3);
    });
});
