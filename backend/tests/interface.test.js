/**
 * Tests for generators/interface module.
 */

const path = require("path");
const {
    makeInterface,
    isInterface,
} = require("../src/generators/interface");
const {
    LIVE_DATABASE_WORKING_PATH,
} = require("../src/generators/incremental_graph");
const eventId = require("../src/event/id");
const { fromISOString } = require("../src/datetime");
const { transaction } = require("../src/event_log_storage");
const {
    stubIncrementalDatabaseRemote,
    stubPopulatedIncrementalDatabaseRemote,
} = require("./stub_incremental_database_remote");
const { getMockedRootCapabilities } = require("./spies");
const {
    stubLogger,
    stubEnvironment,
    stubDatetime,
    ensureLiveDatabaseDirectory,
} = require("./stubs");

/**
 * @typedef {import('../src/generators/incremental_graph/database/types').DatabaseCapabilities} DatabaseCapabilities
 */

/**
 * Creates test capabilities.
 * @returns {Promise<object>}
 */
async function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    ensureLiveDatabaseDirectory(capabilities);
    await stubIncrementalDatabaseRemote(capabilities);
    return capabilities;
}

/**
 * Builds a minimal well-formed event for testing.
 * @param {string} id
 * @param {string} input
 */
function makeEvent(id, input) {
    return {
        id: eventId.fromString(id),
        date: fromISOString("2024-01-01T00:00:00.000Z"),
        original: `text ${input}`,
        input: `text ${input}`,
        creator: { name: "test", uuid: "00000000-0000-0000-0000-000000000001", version: "0.0.0", hostname: "test-host" },
    };
}

/**
 * Writes events to the event log gitstore via a transaction.
 * @param {object} capabilities
 * @param {Array<object>} events
 */
async function writeEventsToStore(capabilities, events) {
    await transaction(capabilities, async (storage) => {
        for (const event of events) {
            storage.addEntry(event, []);
        }
    });
}

describe("generators/interface", () => {
    describe("makeInterface()", () => {
        test("creates and returns an interface instance", async () => {
            const capabilities = await getTestCapabilities();
            const iface = makeInterface(() => capabilities);
            await iface.ensureInitialized();
            expect(isInterface(iface)).toBe(true);
        });
    });

    describe("update()", () => {
        test("stores events in database under all_events key", async () => {
            const capabilities = await getTestCapabilities();
            const iface = capabilities.interface;
            await iface.ensureInitialized();

            await iface.update([
                makeEvent("event-1", "First event"),
                makeEvent("event-2", "Second event"),
            ]);

            const result = await iface._incrementalGraph.pull("all_events");
            expect(result).toBeDefined();
            expect(result.events).toHaveLength(2);
            expect(result.events[0].id).toBe("event-1");
            expect(result.events[1].id).toBe("event-2");

            const freshness = await iface.getFreshness("all_events");
            expect(freshness).toBe("up-to-date");
        });

        test("reflects the updated state after an event is replaced", async () => {
            const capabilities = await getTestCapabilities();
            const iface = capabilities.interface;
            await iface.ensureInitialized();

            await iface.update([makeEvent("event-1", "original text")]);

            let result = await iface._incrementalGraph.pull("all_events");
            expect(result.events).toHaveLength(1);
            expect(result.events[0].id).toBe("event-1");

            // Replace event-1 with new content and add event-2
            await iface.update([
                makeEvent("event-1", "updated text"),
                makeEvent("event-2", "new event"),
            ]);

            result = await iface._incrementalGraph.pull("all_events");
            expect(result.events).toHaveLength(2);
            const ids = result.events.map((e) => e.id);
            expect(ids).toContain("event-1");
            expect(ids).toContain("event-2");
            const e1 = result.events.find((e) => e.id === "event-1");
            expect(e1).toBeDefined();
            expect(e1.input).toBe("text updated text");
        });

        test("handles empty store (returns no events)", async () => {
            const capabilities = await getTestCapabilities();
            const iface = capabilities.interface;
            await iface.ensureInitialized();

            await iface.update([]);

            const result = await iface._incrementalGraph.pull("all_events");
            expect(result).toBeDefined();
            expect(result.events).toHaveLength(0);

            const freshness = await iface.getFreshness("all_events");
            expect(freshness).toBe("up-to-date");
        });

        test("update() persists all_events immediately (up-to-date after update)", async () => {
            const capabilities = await getTestCapabilities();
            const iface = capabilities.interface;
            await iface.ensureInitialized();

            await iface.update([makeEvent("event-1", "first")]);
            await iface.pullGraphNode("all_events");

            await iface.update([makeEvent("event-2", "second")]);

            // With the fix, update() immediately pulls, so the node is always up-to-date.
            await expect(iface.getFreshness("all_events")).resolves.toBe(
                "up-to-date"
            );
            await expect(iface.pullGraphNode("all_events")).resolves.toMatchObject({
                type: "all_events",
                events: [{ id: "event-2" }],
            });
            await expect(iface.getFreshness("all_events")).resolves.toBe(
                "up-to-date"
            );
        });

        test("is a no-op before ensureInitialized()", async () => {
            const capabilities = await getTestCapabilities();
            const iface = capabilities.interface;
            // Should not throw before initialization
            await expect(iface.update([])).resolves.toBeUndefined();
        });

        test("does not fail when synchronizeDatabase() runs concurrently between invalidate and pull", async () => {

            // Regression test for the race condition where synchronizeDatabase() sets
            // _incrementalGraph to null between the invalidate() and pull() calls in
            // internalUpdate(), causing "Impossible: expected non-null".
            const capabilities = await getTestCapabilities();
            const iface = capabilities.interface;
            await iface.ensureInitialized();

            // Use deferred promises to control timing deterministically.
            /** @type {() => void} */
            let resolveInvalidateDone;
            const invalidateDone = new Promise((resolve) => {
                resolveInvalidateDone = resolve;
            });
            /** @type {() => void} */
            let resolveAllowReturn;
            const allowReturn = new Promise((resolve) => {
                resolveAllowReturn = resolve;
            });

            // Intercept invalidate() to create a controlled pause: after invalidate
            // completes (releasing observe mode), we signal that the race window is open,
            // then wait before returning so the test can inject a concurrent sync.
            const graph = iface._incrementalGraph;
            const originalInvalidate = graph.invalidate.bind(graph);
            graph.invalidate = async (...args) => {
                const result = await originalInvalidate(...args);
                // Observe mode has now been released — the race window is open.
                resolveInvalidateDone();
                // Hold here until the test releases us.
                await allowReturn;
                return result;
            };

            // Start update() — it will block inside our patched invalidate().
            const updatePromise = iface.update([makeEvent("event-1", "concurrent")]);

            // Wait until invalidate has finished (observe mode released).
            await invalidateDone;

            // Start synchronizeDatabase() NOW — this is the race: sync can acquire
            // exclusive mode (since observe mode is released) and set _incrementalGraph
            // to null before update() reaches pull().
            // With the fix (MUTEX_KEY held by update()), sync is blocked here.
            const syncPromise = iface.synchronizeDatabase();

            // Give the event loop a chance to process any immediately-runnable microtasks
            // (in particular, let synchronizeDatabase try to acquire its locks).
            await new Promise((resolve) => setImmediate(resolve));

            // Allow invalidate() to return — update() will now proceed to pull().
            // Without the fix, _incrementalGraph is null here → ERROR.
            // With the fix, sync is still blocked → _incrementalGraph is non-null → OK.
            resolveAllowReturn();

            // update() should succeed.
            await expect(updatePromise).resolves.toBeUndefined();

            // Let sync finish too.
            await syncPromise;

            // Verify the events survive.
            const events = await iface.getAllEvents();
            expect(events).toHaveLength(1);
            expect(events[0].id.identifier).toBe("event-1");
        }, 20000);

        test("events survive a simulated restart (synchronizeDatabase reopen)", async () => {
            // Regression test: events must not reset to [] after a restart.
            // Before the fix, update() only invalidated all_events without persisting the
            // new value, so a restart would cause the next pull to recompute from an empty
            // initial state, wiping all events.
            const capabilities = await getTestCapabilities();
            const iface = capabilities.interface;
            await iface.ensureInitialized();

            await iface.update([
                makeEvent("event-1", "First event"),
                makeEvent("event-2", "Second event"),
            ]);

            // Simulate a restart: close and reopen the database.
            await iface.synchronizeDatabase();

            // Events must still be present after the restart.
            const events = await iface.getAllEvents();
            expect(events).toHaveLength(2);
            const ids = events.map((e) => e.id.identifier);
            expect(ids).toContain("event-1");
            expect(ids).toContain("event-2");
        }, 20000);
    });

    describe("synchronizeDatabase()", () => {
        test("closes and reopens the database when the interface is initialized", async () => {
            const capabilities = await getTestCapabilities();
            const originalInitialize = capabilities.levelDatabase.initialize;
            /** @type {Array<{ open: jest.Mock, close: jest.Mock }>} */
            const rawDatabases = [];
            capabilities.levelDatabase.initialize = jest.fn((databasePath) => {
                const db = originalInitialize(databasePath);
                const originalOpen = db.open.bind(db);
                const originalClose = db.close.bind(db);
                db.open = jest.fn(() => originalOpen());
                db.close = jest.fn(() => originalClose());
                rawDatabases.push(db);
                return db;
            });

            const iface = makeInterface(() => capabilities);
            await iface.ensureInitialized();

            await iface.synchronizeDatabase();

            expect(rawDatabases).toHaveLength(3);
            expect(capabilities.levelDatabase.initialize).toHaveBeenCalledTimes(3);
            // [0] initial live DB, closed at the start of synchronizeDatabase.
            expect(rawDatabases[0].close).toHaveBeenCalledTimes(1);
            // [1] DB opened by synchronizeNoLock during the regular sync call.
            expect(rawDatabases[1].close).toHaveBeenCalledTimes(1);
            // [2] the new live DB opened after synchronizeDatabase.
            expect(rawDatabases[2].open).toHaveBeenCalled();
            expect(iface.isInitialized()).toBe(true);
            await expect(iface._incrementalGraph.pull("all_events")).resolves.toMatchObject({
                type: "all_events",
                events: [],
            });
        });
    });

    describe("getEventBasicContext()", () => {
        test("returns context for event with shared hashtags", async () => {
            const capabilities = await getTestCapabilities();
            const iface = capabilities.interface;
            await iface.ensureInitialized();

            const events = [
                makeEvent("1", "First #project event"),
                makeEvent("2", "Second #project event"),
                makeEvent("3", "Unrelated #other event"),
            ];

            await writeEventsToStore(capabilities, events);

            // Get context for first event
            const context = await iface.getEventBasicContext(events[0]);

            // Should include both events with #project
            expect(context).toHaveLength(2);
            const contextIds = context.map((e) => e.id.identifier);
            expect(contextIds).toContain("1");
            expect(contextIds).toContain("2");
            expect(contextIds).not.toContain("3");
        });

        test("returns only the event itself when no shared hashtags", async () => {
            const capabilities = await getTestCapabilities();
            const iface = capabilities.interface;
            await iface.ensureInitialized();

            const events = [makeEvent("1", "Event without hashtags")];

            await writeEventsToStore(capabilities, events);

            const context = await iface.getEventBasicContext(events[0]);

            expect(context).toHaveLength(1);
            expect(context[0].id.identifier).toBe("1");
        });

        test("propagates through incremental graph before returning context", async () => {
            const capabilities = await getTestCapabilities();
            const iface = capabilities.interface;
            await iface.ensureInitialized();

            const events = [makeEvent("1", "Test #tag event")];

            await writeEventsToStore(capabilities, events);

            // Get context - this should trigger propagation
            const context = await iface.getEventBasicContext(events[0]);

            expect(context).toBeDefined();
            expect(context).toHaveLength(1);

            // Verify that event_context was computed in the incremental graph
            const eventContextEntry = await iface._incrementalGraph.pull("event_context");
            expect(eventContextEntry).toBeDefined();
            expect(eventContextEntry.type).toBe("event_context");
            expect(eventContextEntry.contexts).toHaveLength(1);
        });
    });

    describe("getAllEvents()", () => {
        test("returns all events from the incremental graph", async () => {
            const capabilities = await getTestCapabilities();
            const iface = capabilities.interface;
            await iface.ensureInitialized();

            await writeEventsToStore(capabilities, [
                makeEvent("event-1", "First event"),
                makeEvent("event-2", "Second event"),
            ]);

            const events = await iface.getAllEvents();

            expect(events).toHaveLength(2);
            const ids = events.map((e) => e.id.identifier);
            expect(ids).toContain("event-1");
            expect(ids).toContain("event-2");
        });

        test("returns empty array when no events exist", async () => {
            const capabilities = await getTestCapabilities();
            const iface = capabilities.interface;
            await iface.ensureInitialized();

            const events = await iface.getAllEvents();
            expect(events).toHaveLength(0);
        });

        test("returns events with proper DateTime instances (cache hit path)", async () => {
            const capabilities = await getTestCapabilities();
            const iface = capabilities.interface;
            await iface.ensureInitialized();

            await writeEventsToStore(capabilities, [makeEvent("event-1", "First event")]);

            // First call: computes all_events fresh
            const firstResult = await iface.getAllEvents();
            expect(firstResult).toHaveLength(1);

            // Second call: reads from DB cache – DateTime must still be a proper instance
            const secondResult = await iface.getAllEvents();
            expect(secondResult).toHaveLength(1);
            // Ensure the date supports DateTime methods (would throw on plain JSON object)
            expect(typeof secondResult[0].date.toISOString()).toBe("string");
        });
    });

    describe("getEvent()", () => {
        test("returns the event for an existing id", async () => {
            const capabilities = await getTestCapabilities();
            const iface = capabilities.interface;
            await iface.ensureInitialized();

            const event1 = makeEvent("event-1", "First event");
            await writeEventsToStore(capabilities, [event1]);

            const result = await iface.getEvent("event-1");
            expect(result).not.toBeNull();
            expect(result.id.identifier).toBe("event-1");
        });

        test("returns null for a non-existent id", async () => {
            const capabilities = await getTestCapabilities();
            const iface = capabilities.interface;
            await iface.ensureInitialized();

            const result = await iface.getEvent("does-not-exist");
            expect(result).toBeNull();
        });

        test("can fetch multiple different events in sequence (cache hit path)", async () => {
            const capabilities = await getTestCapabilities();
            const iface = capabilities.interface;
            await iface.ensureInitialized();

            await writeEventsToStore(capabilities, [
                makeEvent("event-1", "First event"),
                makeEvent("event-2", "Second event"),
            ]);

            // First call primes the all_events cache
            const first = await iface.getEvent("event-1");
            expect(first).not.toBeNull();
            expect(first.id.identifier).toBe("event-1");

            // Second call uses the cached all_events – DateTime must remain functional
            const second = await iface.getEvent("event-2");
            expect(second).not.toBeNull();
            expect(second.id.identifier).toBe("event-2");
            expect(typeof second.date.toISOString()).toBe("string");
        });
    });

    describe("Type guards", () => {
        test("isInterface correctly identifies instances", async () => {
            const capabilities = await getTestCapabilities();
            const iface = makeInterface(() => capabilities);
            await iface.ensureInitialized();

            expect(isInterface(iface)).toBe(true);
            expect(isInterface({})).toBe(false);
            expect(isInterface(null)).toBe(false);
            expect(isInterface(undefined)).toBe(false);
        });
    });

    describe("bootstrap path selection", () => {
        test("V3: uses reset-to-hostname sync when LevelDB is absent and hostname branch exists remotely", async () => {
            // Setup: remote WITH hostname branch (test-host-main), no local LevelDB.
            const capabilities = getMockedRootCapabilities();
            stubEnvironment(capabilities);
            stubLogger(capabilities);
            stubDatetime(capabilities);
            ensureLiveDatabaseDirectory(capabilities);
            await stubPopulatedIncrementalDatabaseRemote(capabilities);
            // Delete the pre-created LevelDB dir to trigger the bootstrap path.
            const liveDbPath = path.join(
                capabilities.environment.workingDirectory(),
                LIVE_DATABASE_WORKING_PATH
            );
            await capabilities.deleter.deleteDirectory(liveDbPath);

            const iface = makeInterface(() => capabilities);
            await iface.ensureInitialized();

            // Verify the reset-to-hostname path was taken.
            expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                expect.objectContaining({ hostname: 'test-host' }),
                'Bootstrap: hostname branch found; using reset-to-hostname sync path'
            );
            await expect(iface.getAllEvents()).resolves.toHaveLength(3);
            await expect(iface.getConfig()).resolves.toMatchObject({
                help: expect.stringContaining("Event logging help text"),
                shortcuts: expect.arrayContaining([
                    ["breakfast", "food [when this morning]", "Quick breakfast entry"],
                ]),
            });
            expect(isInterface(iface)).toBe(true);
        });

        test("V4: uses fallback normal sync when LevelDB is absent and hostname branch is absent remotely", async () => {
            // Setup: remote WITHOUT the hostname branch (only a non-hostname branch), no local LevelDB.
            const capabilities = getMockedRootCapabilities();
            stubEnvironment(capabilities);
            stubLogger(capabilities);
            stubDatetime(capabilities);

            // Create a bare remote that has only 'main' (not 'test-host-main').
            const gitDir = capabilities.environment.generatorsRepository();
            await capabilities.git.call("init", "--bare", "--", gitDir);
            const workTree = path.join(
                capabilities.environment.workingDirectory(),
                "bootstrap-v4-setup"
            );
            await capabilities.creator.createDirectory(workTree);
            await capabilities.git.call(
                "init", "--initial-branch", "main", "--", workTree
            );
            const readmeFile = path.join(workTree, "README");
            const readmeObj = await capabilities.creator.createFile(readmeFile);
            await capabilities.writer.writeFile(readmeObj, "bootstrap test remote");
            await capabilities.git.call("-C", workTree, "add", "--all");
            await capabilities.git.call(
                "-C", workTree,
                "-c", "user.name=test",
                "-c", "user.email=test@example.com",
                "commit", "-m", "initial"
            );
            await capabilities.git.call(
                "-C", workTree, "remote", "add", "origin", "--", gitDir
            );
            await capabilities.git.call("-C", workTree, "push", "origin", "main");

            // Delete the pre-created LevelDB dir to trigger the bootstrap path.
            // The production code (internalInitCheckpointRepoForFallback) will
            // automatically initialize the checkpoint repo and configure the
            // origin remote, so no manual pre-initialization is needed here.
            ensureLiveDatabaseDirectory(capabilities);
            const liveDbPath = path.join(
                capabilities.environment.workingDirectory(),
                LIVE_DATABASE_WORKING_PATH
            );
            await capabilities.deleter.deleteDirectory(liveDbPath);

            const iface = makeInterface(() => capabilities);
            await iface.ensureInitialized();

            // Verify the fallback normal-sync path was taken.
            expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                expect.objectContaining({ hostname: 'test-host' }),
                'Bootstrap: hostname branch does not exist remotely; using normal sync fallback'
            );
            expect(isInterface(iface)).toBe(true);
        });
    });
});
