/**
 * Tests for generators/interface module.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { getRootDatabase } = require("../src/generators/dependency_graph/database");
const {
    makeInterface,
    isInterface,
} = require("../src/generators/interface");
const eventId = require("../src/event/id");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger } = require("./stubs");

/**
 * @typedef {import('../src/generators/dependency_graph/database/types').DatabaseCapabilities} DatabaseCapabilities
 */

/**
 * Creates test capabilities with a temporary data directory.
 * @returns {DatabaseCapabilities & { tmpDir: string }}
 */
function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "interface-test-")
    );

    stubLogger(capabilities);

    // Override environment to use temp directory
    capabilities.environment = {
        pathToVolodyslavDataDirectory: jest.fn().mockReturnValue(tmpDir),
    };

    return { ...capabilities, tmpDir };
}

/**
 * Cleanup function to remove temporary directories.
 * @param {string} tmpDir
 */
function cleanup(tmpDir) {
    if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

describe("generators/interface", () => {
    describe("makeInterface()", () => {
        test("creates and returns an interface instance", async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getRootDatabase(capabilities);
                const iface = makeInterface(db);

                expect(isInterface(iface)).toBe(true);

                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });
    });

    describe("update()", () => {
        test("stores events in database under all_events key", async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getRootDatabase(capabilities);
                const iface = makeInterface(db);

                const events = [
                    {
                        id: "event-1",
                        type: "test",
                        description: "First event",
                        date: "2024-01-01",
                        modifiers: {},
                    },
                    {
                        id: "event-2",
                        type: "test",
                        description: "Second event",
                        date: "2024-01-02",
                        modifiers: {},
                    },
                ];

                await iface.update(events);

                // Verify the data was stored correctly by pulling from the dependency graph
                const result = await iface.dependencyGraph.pull("all_events");
                expect(result).toBeDefined();
                expect(result.events).toHaveLength(2);
                expect(result.events[0].id).toBe("event-1");
                expect(result.events[1].id).toBe("event-2");
                
                const freshness = await iface.dependencyGraph.debugGetFreshness("all_events");
                expect(freshness).toBe("up-to-date");

                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test("overwrites previous events on subsequent updates", async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getRootDatabase(capabilities);
                const iface = makeInterface(db);

                const firstEvents = [
                    {
                        id: "event-1",
                        type: "test",
                        description: "First event",
                        date: "2024-01-01",
                        modifiers: {},
                    },
                ];

                const secondEvents = [
                    {
                        id: "event-2",
                        type: "test",
                        description: "Second event",
                        date: "2024-01-02",
                        modifiers: {},
                    },
                    {
                        id: "event-3",
                        type: "test",
                        description: "Third event",
                        date: "2024-01-03",
                        modifiers: {},
                    },
                ];

                await iface.update(firstEvents);
                await iface.update(secondEvents);

                const result = await iface.dependencyGraph.pull("all_events");
                expect(result.events).toHaveLength(2);
                expect(result.events[0].id).toBe("event-2");
                expect(result.events[1].id).toBe("event-3");

                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test("handles empty events array", async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getRootDatabase(capabilities);
                const iface = makeInterface(db);

                await iface.update([]);

                const result = await iface.dependencyGraph.pull("all_events");
                expect(result).toBeDefined();
                expect(result.events).toHaveLength(0);
                
                const freshness = await iface.dependencyGraph.debugGetFreshness("all_events");
                expect(freshness).toBe("up-to-date");

                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });
    });

    describe("getEventBasicContext()", () => {
        test("returns context for event with shared hashtags", async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getRootDatabase(capabilities);
                const iface = makeInterface(db);

                const events = [
                    {
                        id: eventId.fromString("1"),
                        type: "text",
                        description: "First #project event",
                        date: "2024-01-01",
                        original: "First #project event",
                        input: "First #project event",
                        modifiers: {},
                        creator: { type: "user", name: "test" },
                    },
                    {
                        id: eventId.fromString("2"),
                        type: "text",
                        description: "Second #project event",
                        date: "2024-01-02",
                        original: "Second #project event",
                        input: "Second #project event",
                        modifiers: {},
                        creator: { type: "user", name: "test" },
                    },
                    {
                        id: eventId.fromString("3"),
                        type: "text",
                        description: "Unrelated #other event",
                        date: "2024-01-03",
                        original: "Unrelated #other event",
                        input: "Unrelated #other event",
                        modifiers: {},
                        creator: { type: "user", name: "test" },
                    },
                ];

                await iface.update(events);

                // Get context for first event
                const context = await iface.getEventBasicContext(events[0]);

                // Should include both events with #project
                expect(context).toHaveLength(2);
                const contextIds = context.map(e => e.id.identifier);
                expect(contextIds).toContain("1");
                expect(contextIds).toContain("2");
                expect(contextIds).not.toContain("3");

                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test("returns only the event itself when no shared hashtags", async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getRootDatabase(capabilities);
                const iface = makeInterface(db);

                const events = [
                    {
                        id: eventId.fromString("1"),
                        type: "text",
                        description: "Event without hashtags",
                        date: "2024-01-01",
                        original: "test1",
                        input: "test1",
                        modifiers: {},
                        creator: { type: "user", name: "test" },
                    },
                ];

                await iface.update(events);

                const context = await iface.getEventBasicContext(events[0]);

                expect(context).toHaveLength(1);
                expect(context[0].id.identifier).toBe("1");

                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test("propagates through dependency graph before returning context", async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getRootDatabase(capabilities);
                const iface = makeInterface(db);

                // Add events
                const events = [
                    {
                        id: eventId.fromString("1"),
                        type: "text",
                        description: "Test #tag event",
                        date: "2024-01-01",
                        original: "Test #tag event",
                        input: "Test #tag event",
                        modifiers: {},
                        creator: { type: "user", name: "test" },
                    },
                ];

                await iface.update(events);

                // Get context - this should trigger propagation
                const context = await iface.getEventBasicContext(events[0]);

                expect(context).toBeDefined();
                expect(context).toHaveLength(1);

                // Verify that event_context was computed in the dependency graph
                const eventContextEntry = await iface.dependencyGraph.pull("event_context");
                expect(eventContextEntry).toBeDefined();
                expect(eventContextEntry.type).toBe("event_context");
                expect(eventContextEntry.contexts).toHaveLength(1);

                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });
    });

    describe("Type guards", () => {
        test("isInterface correctly identifies instances", async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getRootDatabase(capabilities);
                const iface = makeInterface(db);

                expect(isInterface(iface)).toBe(true);
                expect(isInterface({})).toBe(false);
                expect(isInterface(null)).toBe(false);
                expect(isInterface(undefined)).toBe(false);

                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });
    });
});
