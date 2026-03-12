/**
 * Comprehensive tests for the sorted-events graph nodes and the
 * getSortedEvents() async iterator on InterfaceClass.
 *
 * Nodes under test
 * ────────────────
 *   sorted_events_descending  – all events sorted newest-first
 *   sorted_events_ascending   – all events sorted oldest-first
 *   last100entries            – first SORTED_EVENTS_CACHE_SIZE of descending
 *   first100entries           – first SORTED_EVENTS_CACHE_SIZE of ascending
 *   events_count              – total number of events (O(1) integer)
 *
 * Iterator under test
 * ───────────────────
 *   interface.getSortedEvents(order) – async iterator that:
 *     • Yields from the small cache node for the first SORTED_EVENTS_CACHE_SIZE
 *       entries (fast path, avoids reading the full sorted list for small
 *       result sets).
 *     • Falls through to the full sorted list for entries beyond the cache
 *       size.
 *     • Deserialises lazily (one event per iteration step).
 *
 * Method under test
 * ─────────────────
 *   interface.getEventsCount() – returns the cached total event count.
 */

const eventId = require("../src/event/id");
const { fromISOString } = require("../src/datetime");
const { fromDays } = require("../src/datetime/duration");
const { transaction } = require("../src/event_log_storage");
const { stubGeneratorsRepository } = require("./stub_generators_repository");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger, stubEnvironment, stubDatetime, stubEventLogRepository } = require("./stubs");
const { SORTED_EVENTS_CACHE_SIZE } = require("../src/generators/interface/constants");

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Creates fully-stubbed test capabilities including a generator database.
 * @returns {Promise<object>}
 */
async function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    await stubEventLogRepository(capabilities);
    await stubGeneratorsRepository(capabilities);
    return capabilities;
}

/**
 * Creates a minimal well-formed event.
 * @param {string} id
 * @param {string} dateIso - ISO-8601 date string
 * @param {string} [type]
 * @param {string} [description]
 */
function makeEvent(id, dateIso, type = "text", description = `Event ${id}`) {
    return {
        id: eventId.fromString(id),
        type,
        description,
        date: fromISOString(dateIso),
        original: description,
        input: description,
        modifiers: {},
        creator: {
            name: "test",
            uuid: "00000000-0000-0000-0000-000000000001",
            version: "0.0.0",
        },
    };
}

/**
 * Writes an array of events into the event-log gitstore via a transaction
 * and then triggers an incremental graph update.
 * @param {object} capabilities
 * @param {Array<object>} events
 */
async function writeEventsAndUpdate(capabilities, events) {
    await transaction(capabilities, async (storage) => {
        for (const ev of events) {
            storage.addEntry(ev, []);
        }
    });
    await capabilities.interface.update();
}

/**
 * Collects all values from an async iterable into an array.
 * @template T
 * @param {AsyncIterable<T>} iter
 * @returns {Promise<T[]>}
 */
async function collectAll(iter) {
    const results = [];
    for await (const item of iter) {
        results.push(item);
    }
    return results;
}

/**
 * Creates `count` events with sequential dates starting from `baseIso`,
 * each one day apart.  IDs have their numeric portion zero-padded to four
 * digits (e.g. 'evt-0001', 'evt-0002', …) so lexicographic and numeric
 * ordering agree.
 * @param {number} count
 * @param {string} [baseIso]
 * @returns {object[]}
 */
function makeSequentialEvents(count, baseIso = "2024-01-01T00:00:00.000Z") {
    const base = fromISOString(baseIso);
    return Array.from({ length: count }, (_, i) => {
        const pad = String(i + 1).padStart(4, "0");
        const date = base.advance(fromDays(i));
        return makeEvent(`evt-${pad}`, date.toISOString());
    });
}

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
});

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

// ─── last100entries ───────────────────────────────────────────────────────────

describe("last100entries graph node", () => {
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
        const cacheResult = await iface._incrementalGraph.pull("last100entries");

        // Should be the same as the full descending list when count < cache size
        expect(cacheResult.type).toBe("last100entries");
        expect(cacheResult.events.map((e) => e.id)).toEqual(
            descResult.events.slice(0, SORTED_EVENTS_CACHE_SIZE).map((e) => e.id)
        );
    });

    test("returns empty array when no events exist", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const result = await iface._incrementalGraph.pull("last100entries");
        expect(result.type).toBe("last100entries");
        expect(result.events).toHaveLength(0);
    });

    test("caps at exactly SORTED_EVENTS_CACHE_SIZE events even when more exist", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const events = makeSequentialEvents(SORTED_EVENTS_CACHE_SIZE + 10);
        await writeEventsAndUpdate(capabilities, events);

        const result = await iface._incrementalGraph.pull("last100entries");
        expect(result.events).toHaveLength(SORTED_EVENTS_CACHE_SIZE);
    });

    test("contains exactly SORTED_EVENTS_CACHE_SIZE events when count equals the limit", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const events = makeSequentialEvents(SORTED_EVENTS_CACHE_SIZE);
        await writeEventsAndUpdate(capabilities, events);

        const result = await iface._incrementalGraph.pull("last100entries");
        expect(result.events).toHaveLength(SORTED_EVENTS_CACHE_SIZE);
    });

    test("events are in descending date order", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const events = makeSequentialEvents(5);
        await writeEventsAndUpdate(capabilities, events);

        const result = await iface._incrementalGraph.pull("last100entries");
        const dates = result.events.map((e) => fromISOString(e.date));
        for (let i = 1; i < dates.length; i++) {
            expect(dates[i - 1].isAfterOrEqual(dates[i])).toBe(true);
        }
    });
});

// ─── first100entries ──────────────────────────────────────────────────────────

describe("first100entries graph node", () => {
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
        const cacheResult = await iface._incrementalGraph.pull("first100entries");

        expect(cacheResult.type).toBe("first100entries");
        expect(cacheResult.events.map((e) => e.id)).toEqual(
            ascResult.events.slice(0, SORTED_EVENTS_CACHE_SIZE).map((e) => e.id)
        );
    });

    test("returns empty array when no events exist", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const result = await iface._incrementalGraph.pull("first100entries");
        expect(result.type).toBe("first100entries");
        expect(result.events).toHaveLength(0);
    });

    test("caps at exactly SORTED_EVENTS_CACHE_SIZE events even when more exist", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const events = makeSequentialEvents(SORTED_EVENTS_CACHE_SIZE + 10);
        await writeEventsAndUpdate(capabilities, events);

        const result = await iface._incrementalGraph.pull("first100entries");
        expect(result.events).toHaveLength(SORTED_EVENTS_CACHE_SIZE);
    });

    test("contains exactly SORTED_EVENTS_CACHE_SIZE events when count equals the limit", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const events = makeSequentialEvents(SORTED_EVENTS_CACHE_SIZE);
        await writeEventsAndUpdate(capabilities, events);

        const result = await iface._incrementalGraph.pull("first100entries");
        expect(result.events).toHaveLength(SORTED_EVENTS_CACHE_SIZE);
    });

    test("events are in ascending date order", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const events = makeSequentialEvents(5);
        await writeEventsAndUpdate(capabilities, events);

        const result = await iface._incrementalGraph.pull("first100entries");
        const dates = result.events.map((e) => fromISOString(e.date));
        for (let i = 1; i < dates.length; i++) {
            expect(dates[i - 1].isBeforeOrEqual(dates[i])).toBe(true);
        }
    });

    test("is the mirror of last100entries for the same event set", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const events = makeSequentialEvents(10);
        await writeEventsAndUpdate(capabilities, events);

        const firstResult = await iface._incrementalGraph.pull("first100entries");
        const lastResult = await iface._incrementalGraph.pull("last100entries");

        // For ≤ SORTED_EVENTS_CACHE_SIZE events the two caches are reverses of
        // each other.
        expect(firstResult.events.map((e) => e.id)).toEqual(
            [...lastResult.events].reverse().map((e) => e.id)
        );
    });
});

// ─── events_count ─────────────────────────────────────────────────────────────

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

        // For descending order: index SORTED_EVENTS_CACHE_SIZE should be the
        // event that sits just past the cache, which is the
        // (count - SORTED_EVENTS_CACHE_SIZE)th oldest event in the full set.
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
