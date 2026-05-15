const path = require("path");
const { LIVE_DATABASE_WORKING_PATH } = require("../src/generators/incremental_graph");
const { SORTED_EVENTS_CACHE_SIZE } = require("../src/generators/interface/constants");
const { makeEvent, collectAll } = require("./sorted_events_test_helpers");
const { getMockedRootCapabilities } = require("./spies");
const {
    stubEnvironment,
    stubLogger,
    stubDatetime,
    ensureLiveDatabaseDirectory,
} = require("./stubs");
const { stubPopulatedIncrementalDatabaseRemote } = require("./stub_incremental_database_remote");

async function getPopulatedCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    ensureLiveDatabaseDirectory(capabilities);
    await stubPopulatedIncrementalDatabaseRemote(capabilities);
    await capabilities.deleter.deleteDirectory(path.join(capabilities.environment.workingDirectory(), LIVE_DATABASE_WORKING_PATH));
    return capabilities;
}

function expectSortedDescending(events) {
    for (let i = 1; i < events.length; i += 1) {
        expect(events[i - 1].date.isAfterOrEqual(events[i].date)).toBe(true);
    }
}

function expectSortedAscending(events) {
    for (let i = 1; i < events.length; i += 1) {
        expect(events[i - 1].date.isBeforeOrEqual(events[i].date)).toBe(true);
    }
}

jest.setTimeout(30000);

describe("populated incremental-database remote smoke", () => {
    test("bootstraps, exposes expected fixture data, and supports synchronizeDatabase reset", async () => {
        const capabilities = await getPopulatedCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const allEvents = await iface.getAllEvents();
        expect(allEvents).toHaveLength(24);
        expect(allEvents.some((e) => e.id.identifier === "cfocusa01")).toBe(true);
        expect(allEvents.some((e) => e.id.identifier === "alatez999")).toBe(true);
        expect(allEvents.some((e) => e.id.identifier === "bearly111")).toBe(true);
        expect(allEvents.some((e) => e.original.includes("Movie night"))).toBe(true);
        expect(typeof allEvents[0].date.toISOString()).toBe("string");

        const config = await iface.getConfig();
        expect(config).not.toBeNull();
        expect(config.help).toBe("Event logging help text");
        expect(config.shortcuts).toEqual(
            expect.arrayContaining([
                ["breakfast", "food [when this morning]", "Quick breakfast entry"],
                ["focus", "work [type deep] #focus", "Focus session shortcut"],
                ["px", "work [project x] #project-x", "Project X shortcut"],
            ])
        );
    });

    test("getEvent existing/missing and events_count consistency", async () => {
        const capabilities = await getPopulatedCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const existing = await iface.getEvent("cfocusa01");
        expect(existing).not.toBeNull();
        expect(existing.id.identifier).toBe("cfocusa01");
        expect(existing.original).toContain("#focus #project-x");
        expect(existing.date.toISOString()).toBe("2025-02-03T09:15:00.000Z");

        await expect(iface.getEvent("missing-xyz")).resolves.toBeNull();

        const count = await iface.getEventsCount();
        const allEvents = await iface.getAllEvents();
        expect(count).toBe(allEvents.length);

        const countNode = await iface.pullGraphNode("events_count");
        expect(countNode.type).toBe("events_count");
        expect(countNode.count).toBe(24);
    });

    test("sorted iterators and direct sorted pulls are consistent and reverse each other", async () => {
        const capabilities = await getPopulatedCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const descending = await collectAll(iface.getSortedEvents("dateDescending"));
        const ascending = await collectAll(iface.getSortedEvents("dateAscending"));
        expect(descending).toHaveLength(24);
        expect(ascending).toHaveLength(24);
        expectSortedDescending(descending);
        expectSortedAscending(ascending);
        expect(ascending.map((e) => e.id.identifier)).toEqual(
            [...descending.map((e) => e.id.identifier)].reverse()
        );

        const descNode = await iface.pullGraphNode("sorted_events_descending");
        const ascNode = await iface.pullGraphNode("sorted_events_ascending");
        expect(descNode.type).toBe("sorted_events_descending");
        expect(ascNode.type).toBe("sorted_events_ascending");
        expect(ascNode.events.map((e) => e.id)).toEqual([...descNode.events.map((e) => e.id)].reverse());
    });

    test("first/last cache nodes cover full dataset when count is below cache size", async () => {
        const capabilities = await getPopulatedCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const lastEntries = await iface.pullGraphNode("last_entries", [SORTED_EVENTS_CACHE_SIZE]);
        const firstEntries = await iface.pullGraphNode("first_entries", [SORTED_EVENTS_CACHE_SIZE]);
        const descNode = await iface.pullGraphNode("sorted_events_descending");
        const ascNode = await iface.pullGraphNode("sorted_events_ascending");

        expect(lastEntries.events).toHaveLength(24);
        expect(firstEntries.events).toHaveLength(24);
        expect(lastEntries.events.map((e) => e.id)).toEqual(descNode.events.map((e) => e.id));
        expect(firstEntries.events.map((e) => e.id)).toEqual(ascNode.events.map((e) => e.id));
    });

    test("update/context/synchronize-reopen flow works on top of populated fixture", async () => {
        const capabilities = await getPopulatedCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();
        await iface.synchronizeDatabase({ resetToHostname: capabilities.environment.hostname() });
        expect(await iface.getEventsCount()).toBe(24);

        const baselineEvents = await iface.getAllEvents();
        await iface.update([
            ...baselineEvents,
            makeEvent("newfix001", "2025-04-25T09:00:00.000Z", "text", "New fixture smoke event #focus"),
            makeEvent("newfix002", "2025-01-01T09:00:00.000Z", "text", "Older inserted fixture smoke event"),
        ]);

        expect(await iface.getEventsCount()).toBe(26);
        expect((await iface.getEvent("newfix001")).id.identifier).toBe("newfix001");

        const desc = await collectAll(iface.getSortedEvents("dateDescending"));
        expect(desc[0].id.identifier).toBe("newfix001");
        expect(desc.some((e) => e.id.identifier === "cfocusa01")).toBe(true);

        const focusEvent = await iface.getEvent("cfocusa01");
        const context = await iface.getEventBasicContext(focusEvent);
        const contextIds = context.map((e) => e.id.identifier);
        expect(contextIds).toContain("cfocusa01");
        expect(contextIds).not.toContain("enotags01x");

        await iface.synchronizeDatabase();
        expect(await iface.getEventsCount()).toBe(26);
        expect((await iface.getConfig()).help).toBe("Event logging help text");
    });
});
