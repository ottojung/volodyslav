jest.setTimeout(30000);

const path = require("path");
const { fromISOString, isDateTime } = require("../src/datetime");
const { SORTED_EVENTS_CACHE_SIZE } = require("../src/generators/interface/constants");
const { LIVE_DATABASE_WORKING_PATH } = require("../src/generators/incremental_graph");
const { stubPopulatedIncrementalDatabaseRemote } = require("./stub_incremental_database_remote");
const { getMockedRootCapabilities } = require("./spies");
const {
    stubLogger,
    stubEnvironment,
    stubDatetime,
    ensureLiveDatabaseDirectory,
} = require("./stubs");

const ANCHOR_IDS = {
    earliest: "fx-anchor-earliest",
    focusA: "fx-anchor-focus-a",
    focusB: "fx-anchor-focus-b",
    healthA: "fx-anchor-health-a",
    noTags: "fx-anchor-no-tags",
    latest: "fx-anchor-latest",
};

async function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    ensureLiveDatabaseDirectory(capabilities);
    await stubPopulatedIncrementalDatabaseRemote(capabilities);
    const liveDbPath = path.join(
        capabilities.environment.workingDirectory(),
        LIVE_DATABASE_WORKING_PATH
    );
    await capabilities.deleter.deleteDirectory(liveDbPath);
    return capabilities;
}

async function collectAll(iter) {
    const results = [];
    for await (const item of iter) {
        results.push(item);
    }
    return results;
}

function assertAscending(events) {
    for (let i = 1; i < events.length; i += 1) {
        expect(events[i - 1].date.compare(events[i].date) <= 0).toBe(true);
    }
}

function assertDescending(events) {
    for (let i = 1; i < events.length; i += 1) {
        expect(events[i - 1].date.compare(events[i].date) >= 0).toBe(true);
    }
}

describe("populated incremental-database remote smoke", () => {
    test("bootstraps from populated fixture", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        expect(iface._incrementalGraph).toBeTruthy();
        await expect(iface.synchronizeDatabase()).resolves.toBeUndefined();
        expect(iface._incrementalGraph).toBeTruthy();
    });

    test("getAllEvents returns realistic fixture dataset", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const events = await iface.getAllEvents();
        expect(events).toHaveLength(24);
        for (const anchorId of Object.values(ANCHOR_IDS)) {
            expect(events.some((e) => e.id.identifier === anchorId)).toBe(true);
        }
        expect(events.some((e) => e.input.includes("#project-x"))).toBe(true);
        expect(events.some((e) => e.input.includes("no tags"))).toBe(true);
        expect(events.every((e) => isDateTime(e.date))).toBe(true);
    });

    test("getConfig and getEvent work for existing/missing ids", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const config = await iface.getConfig();
        expect(config.help).toBe("Event logging help text");
        expect(config.shortcuts.some(([k]) => k === "gym")).toBe(true);
        expect(config.shortcuts.some(([k]) => k === "shipx")).toBe(true);

        const focusA = await iface.getEvent(ANCHOR_IDS.focusA);
        expect(focusA).toBeTruthy();
        expect(focusA.id.identifier).toBe(ANCHOR_IDS.focusA);
        expect(focusA.input).toContain("#focus");
        expect(focusA.date.toISOString()).toBe("2025-02-03T09:15:00.000Z");

        await expect(iface.getEvent("missing-event-id")).resolves.toBe(null);
    });

    test("events_count, sorted pulls, caches, updates, context and synchronize all behave", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const allEvents = await iface.getAllEvents();
        const count = await iface.getEventsCount();
        expect(count).toBe(allEvents.length);

        const countEntry = await iface._incrementalGraph.pull("events_count");
        expect(countEntry.type).toBe("events_count");
        expect(countEntry.count).toBe(24);

        const desc = await collectAll(iface.getSortedEvents("dateDescending"));
        const asc = await collectAll(iface.getSortedEvents("dateAscending"));
        assertDescending(desc);
        assertAscending(asc);
        expect(desc.map((e) => e.id.identifier)).toEqual(
            [...asc].reverse().map((e) => e.id.identifier)
        );

        const descNode = await iface._incrementalGraph.pull("sorted_events_descending");
        const ascNode = await iface._incrementalGraph.pull("sorted_events_ascending");
        expect(descNode.type).toBe("sorted_events_descending");
        expect(ascNode.type).toBe("sorted_events_ascending");
        expect(descNode.events.map((e) => e.id)).toEqual(
            [...ascNode.events].reverse().map((e) => e.id)
        );

        const lastEntries = await iface._incrementalGraph.pull("last_entries", [SORTED_EVENTS_CACHE_SIZE]);
        const firstEntries = await iface._incrementalGraph.pull("first_entries", [SORTED_EVENTS_CACHE_SIZE]);
        expect(lastEntries.events).toHaveLength(24);
        expect(firstEntries.events).toHaveLength(24);
        expect(lastEntries.events.map((e) => e.id)).toEqual(desc.map((e) => e.id.identifier));
        expect(firstEntries.events.map((e) => e.id)).toEqual(asc.map((e) => e.id.identifier));

        const newEvents = [
            {
                id: { identifier: "fx-smoke-new-1" },
                date: fromISOString("2025-04-21T08:00:00.000Z"),
                original: "Smoke inserted newest #focus",
                input: "Smoke inserted newest #focus",
                creator: { name: "test", uuid: "00000000-0000-0000-0000-000000000001", version: "0.0.0-dev", hostname: "test-host" },
            },
            {
                id: { identifier: "fx-smoke-new-2" },
                date: fromISOString("2025-01-01T08:00:00.000Z"),
                original: "Smoke inserted oldest",
                input: "Smoke inserted oldest",
                creator: { name: "test", uuid: "00000000-0000-0000-0000-000000000001", version: "0.0.0-dev", hostname: "test-host" },
            },
        ];

        await iface.update([...allEvents, ...newEvents]);
        expect(await iface.getEventsCount()).toBe(26);
        expect(await iface.getEvent(ANCHOR_IDS.focusA)).toBeTruthy();
        expect(await iface.getEvent("fx-smoke-new-1")).toBeTruthy();

        const updatedDesc = await collectAll(iface.getSortedEvents("dateDescending"));
        expect(updatedDesc[0].id.identifier).toBe("fx-smoke-new-1");

        const focusEvent = await iface.getEvent(ANCHOR_IDS.focusA);
        const focusContextEvents = await iface.getEventBasicContext(focusEvent);
        expect(focusContextEvents.length > 0).toBe(true);
        expect(focusContextEvents.some((e) => e.id.identifier === ANCHOR_IDS.noTags)).toBe(false);

        await iface.synchronizeDatabase();
        expect(await iface.getEventsCount()).toBe(26);
        expect((await iface.getConfig()).help).toBe("Event logging help text");
        expect(await iface.getEvent("fx-smoke-new-1")).toBeTruthy();
    });
});
