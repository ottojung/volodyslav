jest.setTimeout(30000);

const path = require("path");
const { fromISOString, isDateTime } = require("../src/datetime");
const { SORTED_EVENTS_CACHE_SIZE } = require("../src/generators/interface/constants");
const { LIVE_DATABASE_WORKING_PATH } = require("../src/generators/incremental_graph");
const { LAST_NODE_INDEX_KEY } = require("../src/generators/incremental_graph/database");
const { stubPopulatedIncrementalDatabaseRemote } = require("./stub_incremental_database_remote");
const { getMockedRootCapabilities } = require("./spies");
const {
    stubLogger,
    stubEnvironment,
    stubDatetime,
    ensureLiveDatabaseDirectory,
} = require("./stubs");
const {
    fixtureAbsentCohortSource,
    fixtureInputKeys,
    fixtureRecoverySourceHolding,
    readFixtureReplica,
} = require("./journal_startup_fixture");
const { makeJournalAuthor } = require("../src/generators/incremental_graph/journal");
const { resolveCanonicalBootstrapForStartup } = require("../src/generators/incremental_graph/journal_bootstrap_startup");

const POPULATED_FIXTURE = path.join(
    __dirname,
    "mock-incremental-database-remote-populated",
    "rendered",
    "r"
);

const FIXTURE_ALLOCATOR_WATERMARK = 4;

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
    // The deleted local database is completely absent, so the §4 absent-state
    // decision runs: the deployment's recovery source holds the populated
    // fixture's continuation-safe snapshot, which startup restores.
    const recoverySource = fixtureRecoverySourceHolding(POPULATED_FIXTURE);
    if (recoverySource instanceof Error) {
        throw recoverySource;
    }
    capabilities.installationRecoverySource = recoverySource;
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
        // The absent-state restore is receiver-less, so the snapshot's committed
        // writer state supplies the continuing identity, the retained history and
        // the allocator watermark: `global/last_node_index` is the watermark the
        // destroyed database held, not the watermark a fresh projection of the
        // retained records reconstructs.
        await expect(
            iface._database.getSchemaStorage().global.get(LAST_NODE_INDEX_KEY)
        ).resolves.toBe(FIXTURE_ALLOCATOR_WATERMARK);
        await expect(iface.synchronizeDatabase()).resolves.toBeUndefined();
        expect(iface._incrementalGraph).toBeTruthy();
    });

    test("getAllEvents returns realistic fixture dataset", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const events = await iface.getAllEvents();
        expect(events).toHaveLength(26);
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
        expect(config.shortcuts.some((shortcut) => shortcut.pattern === "gym")).toBe(true);
        expect(config.shortcuts.some((shortcut) => shortcut.pattern === "shipx")).toBe(true);

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
        expect(countEntry.count).toBe(26);

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
        expect(lastEntries.events).toHaveLength(26);
        expect(firstEntries.events).toHaveLength(26);
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
        expect(await iface.getEventsCount()).toBe(28);
        expect(await iface.getEvent(ANCHOR_IDS.focusA)).toBeTruthy();
        expect(await iface.getEvent("fx-smoke-new-1")).toBeTruthy();

        const updatedDesc = await collectAll(iface.getSortedEvents("dateDescending"));
        expect(updatedDesc[0].id.identifier).toBe("fx-smoke-new-1");

        const focusEvent = await iface.getEvent(ANCHOR_IDS.focusA);
        const focusContextEvents = await iface.getEventBasicContext(focusEvent);
        expect(focusContextEvents.length > 0).toBe(true);
        expect(focusContextEvents.some((e) => e.id.identifier === ANCHOR_IDS.noTags)).toBe(false);

        await iface.synchronizeDatabase();
        expect(await iface.getEventsCount()).toBe(28);
        expect((await iface.getConfig()).help).toBe("Event logging help text");
        expect(await iface.getEvent("fx-smoke-new-1")).toBeTruthy();
    });
});

describe("populated fixture in the Journal 3 startup lifecycle", () => {
    /**
     * @returns {object}
     */
    function replica() {
        return readFixtureReplica(POPULATED_FIXTURE);
    }

    test("the populated fixture is a Journal replica, so startup does not bootstrap it again", () => {
        const fixture = replica();
        expect(fixture.version).toBe("0.0.0-dev");
        expect(fixture.journalRecordCount).toBeGreaterThan(0);
        expect(fixture.legacyState.nodes.length).toBeGreaterThan(0);
    });

    test("the fixture's persisted graph is one the canonical-bootstrap creator can stage and resume", async () => {
        const fixture = replica();
        const calls = { queries: 0, publications: 0, published: [] };
        const resolution = await resolveCanonicalBootstrapForStartup({
            legacyState: fixture.legacyState,
            localWriter: makeJournalAuthor(fixture.fingerprint),
            target: { databaseVersion: fixture.version, graphSchemeString: fixture.graphSchemeString },
            source: fixtureAbsentCohortSource(calls),
            currentInputKeysOfNode: fixtureInputKeys(fixture.graphSchemeString),
        });
        expect(resolution).not.toBeInstanceOf(Error);
        expect(resolution.operation).toBe("resume-canonical-creator");
        // Every occurrence the fixture persists is reproduced by the canonical cut, with
        // the identifier the fixture already stored rather than a freshly minted one.
        const staged = new Map(
            resolution.projection.occurrences.map((occurrence) => [occurrence.nodeKeyString, occurrence])
        );
        for (const node of fixture.legacyState.nodes) {
            const occurrence = staged.get(node.nodeKeyString);
            expect(occurrence).toBeDefined();
            expect(occurrence.nodeIdentifier).toBe(node.nodeIdentifier);
        }
        expect(resolution.projection.lastNodeIndex).toBe(fixture.lastNodeIndex);
    });
});
