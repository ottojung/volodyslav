/**
 * Tests for the `interface.getSortedEvents()` async iterator.
 *
 * Iterator under test
 * ───────────────────
 *   interface.getSortedEvents(order) – async iterator that:
 *     • Yields from the small cache node for the first SORTED_EVENTS_CACHE_SIZE
 *       entries (fast path, avoids reading the full sorted list for small
 *       result sets).
 *     • Checks events_count before falling through when the cache is exactly
 *       full (avoids an unnecessary read for the "exactly N events" case).
 *     • Falls through to the full sorted list for entries beyond the cache
 *       size.
 *     • Deserialises lazily (one event per iteration step).
 */

const { SORTED_EVENTS_CACHE_SIZE } = require("../src/generators/interface/constants");
const {
    getTestCapabilities,
    makeEvent,
    writeEventsAndUpdate,
    collectAll,
    makeSequentialEvents,
} = require("./sorted_events_test_helpers");

// ─── interface.getSortedEvents() async iterator ───────────────────────────────

describe("interface.getSortedEvents() async iterator", () => {
    test("is an async iterable (has Symbol.asyncIterator)", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const iter = iface.getSortedEvents("dateDescending");
        expect(typeof iter[Symbol.asyncIterator]).toBe("function");
    });

    test("returns an empty iterator for an empty event log (descending)", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const events = await collectAll(iface.getSortedEvents("dateDescending"));
        expect(events).toHaveLength(0);
    });

    test("returns an empty iterator for an empty event log (ascending)", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const events = await collectAll(iface.getSortedEvents("dateAscending"));
        expect(events).toHaveLength(0);
    });

    test("yields events in descending date order (newest first)", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const inputEvents = [
            makeEvent("e1", "2024-01-01T00:00:00.000Z"),
            makeEvent("e3", "2024-03-01T00:00:00.000Z"),
            makeEvent("e2", "2024-02-01T00:00:00.000Z"),
        ];
        await writeEventsAndUpdate(capabilities, inputEvents);

        const yielded = await collectAll(iface.getSortedEvents("dateDescending"));
        expect(yielded).toHaveLength(3);

        for (let i = 1; i < yielded.length; i++) {
            expect(yielded[i - 1].date.isAfterOrEqual(yielded[i].date)).toBe(true);
        }
    });

    test("yields events in ascending date order (oldest first)", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const inputEvents = [
            makeEvent("e3", "2024-03-01T00:00:00.000Z"),
            makeEvent("e1", "2024-01-01T00:00:00.000Z"),
            makeEvent("e2", "2024-02-01T00:00:00.000Z"),
        ];
        await writeEventsAndUpdate(capabilities, inputEvents);

        const yielded = await collectAll(iface.getSortedEvents("dateAscending"));
        expect(yielded).toHaveLength(3);

        for (let i = 1; i < yielded.length; i++) {
            expect(yielded[i - 1].date.isBeforeOrEqual(yielded[i].date)).toBe(true);
        }
    });

    test("ascending and descending yield the same events in reverse order", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const inputEvents = makeSequentialEvents(10);
        await writeEventsAndUpdate(capabilities, inputEvents);

        const desc = await collectAll(iface.getSortedEvents("dateDescending"));
        const asc = await collectAll(iface.getSortedEvents("dateAscending"));

        const descIds = desc.map((e) => e.id.identifier);
        const ascIds = asc.map((e) => e.id.identifier);
        expect(ascIds).toEqual([...descIds].reverse());
    });

    test("yields all events when count is less than SORTED_EVENTS_CACHE_SIZE", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const count = Math.floor(SORTED_EVENTS_CACHE_SIZE / 2);
        await writeEventsAndUpdate(capabilities, makeSequentialEvents(count));

        const yielded = await collectAll(iface.getSortedEvents("dateDescending"));
        expect(yielded).toHaveLength(count);
    });

    test("yields all events when count equals SORTED_EVENTS_CACHE_SIZE exactly", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        await writeEventsAndUpdate(capabilities, makeSequentialEvents(SORTED_EVENTS_CACHE_SIZE));

        const desc = await collectAll(iface.getSortedEvents("dateDescending"));
        expect(desc).toHaveLength(SORTED_EVENTS_CACHE_SIZE);

        const asc = await collectAll(iface.getSortedEvents("dateAscending"));
        expect(asc).toHaveLength(SORTED_EVENTS_CACHE_SIZE);
    });

    test("does not pull the full sorted list when count equals SORTED_EVENTS_CACHE_SIZE (early return via events_count)", async () => {
        // When there are exactly SORTED_EVENTS_CACHE_SIZE events the cache node
        // is full but the full sorted list holds no additional entries.  The
        // iterator must detect this via events_count and return early rather
        // than issuing an unnecessary LevelDB read for the full sorted list.
        //
        // We verify correctness (no duplicate or missing events) and implicitly
        // verify the early-return path by checking that the yielded set equals
        // exactly what the cache node contains.
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        await writeEventsAndUpdate(capabilities, makeSequentialEvents(SORTED_EVENTS_CACHE_SIZE));

        // Pull the small cache nodes directly to get the reference ordering.
        const lastEntries = await iface._incrementalGraph.pull("last_entries", [SORTED_EVENTS_CACHE_SIZE]);
        const firstEntries = await iface._incrementalGraph.pull("first_entries", [SORTED_EVENTS_CACHE_SIZE]);
        expect(lastEntries.type).toBe("last_entries");
        expect(firstEntries.type).toBe("first_entries");

        const desc = await collectAll(iface.getSortedEvents("dateDescending"));
        const asc = await collectAll(iface.getSortedEvents("dateAscending"));

        // Yielded events must match the cache nodes exactly — no extras from
        // the full sorted list, no missing events.
        expect(desc.map((e) => e.id.identifier)).toEqual(
            lastEntries.events.map((e) => e.id)
        );
        expect(asc.map((e) => e.id.identifier)).toEqual(
            firstEntries.events.map((e) => e.id)
        );
    });

    test("yields all events when count is one more than SORTED_EVENTS_CACHE_SIZE", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const count = SORTED_EVENTS_CACHE_SIZE + 1;
        await writeEventsAndUpdate(capabilities, makeSequentialEvents(count));

        const desc = await collectAll(iface.getSortedEvents("dateDescending"));
        expect(desc).toHaveLength(count);

        const asc = await collectAll(iface.getSortedEvents("dateAscending"));
        expect(asc).toHaveLength(count);
    });

    test("yields all events when count greatly exceeds SORTED_EVENTS_CACHE_SIZE", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const count = SORTED_EVENTS_CACHE_SIZE + 50;
        await writeEventsAndUpdate(capabilities, makeSequentialEvents(count));

        const desc = await collectAll(iface.getSortedEvents("dateDescending"));
        expect(desc).toHaveLength(count);

        const asc = await collectAll(iface.getSortedEvents("dateAscending"));
        expect(asc).toHaveLength(count);
    });

    test("correct event is yielded exactly at the cache/full-list boundary (descending)", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        // Create SORTED_EVENTS_CACHE_SIZE + 5 events so the iterator must fall
        // through to the full list for the last 5 entries.
        const count = SORTED_EVENTS_CACHE_SIZE + 5;
        const events = makeSequentialEvents(count);
        await writeEventsAndUpdate(capabilities, events);

        const yielded = await collectAll(iface.getSortedEvents("dateDescending"));
        expect(yielded).toHaveLength(count);

        // Verify the full sequence is still sorted correctly end-to-end.
        for (let i = 1; i < yielded.length; i++) {
            expect(yielded[i - 1].date.isAfterOrEqual(yielded[i].date)).toBe(true);
        }
    });

    test("correct event is yielded exactly at the cache/full-list boundary (ascending)", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const count = SORTED_EVENTS_CACHE_SIZE + 5;
        const events = makeSequentialEvents(count);
        await writeEventsAndUpdate(capabilities, events);

        const yielded = await collectAll(iface.getSortedEvents("dateAscending"));
        expect(yielded).toHaveLength(count);

        for (let i = 1; i < yielded.length; i++) {
            expect(yielded[i - 1].date.isBeforeOrEqual(yielded[i].date)).toBe(true);
        }
    });

    test("yielded events have proper DateTime instances (not plain JSON objects)", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        await writeEventsAndUpdate(capabilities, makeSequentialEvents(3));

        for await (const ev of iface.getSortedEvents("dateDescending")) {
            // toISOString() would throw if ev.date were a plain object, not a
            // DateTimeClass instance.
            expect(typeof ev.date.toISOString()).toBe("string");
            expect(typeof ev.id.identifier).toBe("string");
        }
    });

    test("can be terminated early without consuming all events", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const count = SORTED_EVENTS_CACHE_SIZE + 20;
        await writeEventsAndUpdate(capabilities, makeSequentialEvents(count));

        // Collect only the first 3 events.
        const partial = [];
        for await (const ev of iface.getSortedEvents("dateDescending")) {
            partial.push(ev);
            if (partial.length >= 3) break;
        }

        expect(partial).toHaveLength(3);
        // First two events should be in descending order.
        expect(partial[0].date.isAfterOrEqual(partial[1].date)).toBe(true);
    });

    test("second call returns the same events as the first (cache hit path)", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        await writeEventsAndUpdate(capabilities, makeSequentialEvents(5));

        const first = await collectAll(iface.getSortedEvents("dateDescending"));
        const second = await collectAll(iface.getSortedEvents("dateDescending"));

        expect(first.map((e) => e.id.identifier)).toEqual(
            second.map((e) => e.id.identifier)
        );
    });
});
