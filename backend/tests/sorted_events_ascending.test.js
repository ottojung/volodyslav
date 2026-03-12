/**
 * Tests for the `sorted_events_ascending` incremental-graph node.
 *
 * Node under test
 * ───────────────
 *   sorted_events_ascending – O(n) reverse of `sorted_events_descending`;
 *   recomputed only when `sorted_events_descending` changes.
 */

const { fromISOString } = require("../src/datetime");
const {
    getTestCapabilities,
    makeEvent,
    writeEventsAndUpdate,
} = require("./sorted_events_test_helpers");

// ─── sorted_events_ascending ──────────────────────────────────────────────────

describe("sorted_events_ascending graph node", () => {
    test("stores events sorted by date ascending (oldest first)", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const events = [
            makeEvent("e1", "2024-01-01T00:00:00.000Z"),
            makeEvent("e3", "2024-03-01T00:00:00.000Z"),
            makeEvent("e2", "2024-02-01T00:00:00.000Z"),
        ];
        await writeEventsAndUpdate(capabilities, events);

        const result = await iface._incrementalGraph.pull("sorted_events_ascending");
        expect(result.type).toBe("sorted_events_ascending");
        expect(result.events).toHaveLength(3);

        const dates = result.events.map((e) => e.date);
        for (let i = 1; i < dates.length; i++) {
            expect(fromISOString(dates[i - 1]).isBeforeOrEqual(fromISOString(dates[i]))).toBe(true);
        }
    });

    test("returns empty array when no events exist", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const result = await iface._incrementalGraph.pull("sorted_events_ascending");
        expect(result.type).toBe("sorted_events_ascending");
        expect(result.events).toHaveLength(0);
    });

    test("is the exact reverse of sorted_events_descending", async () => {
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
        const ascResult = await iface._incrementalGraph.pull("sorted_events_ascending");

        const descIds = descResult.events.map((e) => e.id);
        const ascIds = ascResult.events.map((e) => e.id);
        expect(ascIds).toEqual([...descIds].reverse());
    });
});
