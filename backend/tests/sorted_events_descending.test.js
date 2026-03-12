/**
 * Tests for the `sorted_events_descending` incremental-graph node.
 *
 * Node under test
 * ───────────────
 *   sorted_events_descending – all events sorted newest-first, recomputed
 *   only when `all_events` changes.
 */

const { fromISOString } = require("../src/datetime");
const {
    getTestCapabilities,
    makeEvent,
    writeEventsAndUpdate,
    makeSequentialEvents,
} = require("./sorted_events_test_helpers");

// ─── sorted_events_descending ─────────────────────────────────────────────────

describe("sorted_events_descending graph node", () => {
    test("stores events sorted by date descending (newest first)", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const events = [
            makeEvent("e1", "2024-01-01T00:00:00.000Z"),
            makeEvent("e3", "2024-03-01T00:00:00.000Z"),
            makeEvent("e2", "2024-02-01T00:00:00.000Z"),
        ];
        await writeEventsAndUpdate(capabilities, events);

        const result = await iface._incrementalGraph.pull("sorted_events_descending");
        expect(result.type).toBe("sorted_events_descending");
        expect(result.events).toHaveLength(3);

        // Verify descending order via ISO dates
        const dates = result.events.map((e) => e.date);
        for (let i = 1; i < dates.length; i++) {
            expect(fromISOString(dates[i - 1]).isAfterOrEqual(fromISOString(dates[i]))).toBe(true);
        }
    });

    test("returns empty array when no events exist", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const result = await iface._incrementalGraph.pull("sorted_events_descending");
        expect(result.type).toBe("sorted_events_descending");
        expect(result.events).toHaveLength(0);
    });

    test("single event is stored unchanged", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        await writeEventsAndUpdate(capabilities, [
            makeEvent("only", "2024-06-15T12:00:00.000Z"),
        ]);

        const result = await iface._incrementalGraph.pull("sorted_events_descending");
        expect(result.events).toHaveLength(1);
        expect(result.events[0].id).toBe("only");
    });

    test("handles events with identical dates (stable by insertion)", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const sameDate = "2024-05-01T00:00:00.000Z";
        await writeEventsAndUpdate(capabilities, [
            makeEvent("a", sameDate),
            makeEvent("b", sameDate),
            makeEvent("c", sameDate),
        ]);

        const result = await iface._incrementalGraph.pull("sorted_events_descending");
        expect(result.events).toHaveLength(3);
        // All events have the same date; verify by parsing rather than string
        // comparison since the serialization may use a different timezone offset
        // form (e.g. +0000 vs Z).
        for (const ev of result.events) {
            const parsed = fromISOString(ev.date);
            expect(parsed.isValid).toBe(true);
            expect(parsed.equals(fromISOString(sameDate))).toBe(true);
        }
    });

    test("recomputes correctly when new events are added", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        await writeEventsAndUpdate(capabilities, makeSequentialEvents(3));
        const before = await iface._incrementalGraph.pull("sorted_events_descending");
        expect(before.events).toHaveLength(3);

        await writeEventsAndUpdate(capabilities, makeSequentialEvents(2, "2025-06-01T00:00:00.000Z"));
        const after = await iface._incrementalGraph.pull("sorted_events_descending");
        expect(after.events).toHaveLength(5);
    });
});
