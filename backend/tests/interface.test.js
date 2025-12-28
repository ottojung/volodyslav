/**
 * Tests for generators/interface module.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { get: getDatabase } = require("../src/generators/database");
const {
    makeInterface,
    isInterface,
} = require("../src/generators/interface");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger } = require("./stubs");

/**
 * @typedef {import('../src/generators/database/types').DatabaseCapabilities} DatabaseCapabilities
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
                const db = await getDatabase(capabilities);
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
                const db = await getDatabase(capabilities);
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

                // Verify the data was stored correctly
                const result = await db.get("all_events");
                expect(result).toBeDefined();
                expect(result.value.events).toHaveLength(2);
                expect(result.value.events[0].id).toBe("event-1");
                expect(result.value.events[1].id).toBe("event-2");
                expect(result.isDirty).toBe(true);

                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test("overwrites previous events on subsequent updates", async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getDatabase(capabilities);
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

                const result = await db.get("all_events");
                expect(result.value.events).toHaveLength(2);
                expect(result.value.events[0].id).toBe("event-2");
                expect(result.value.events[1].id).toBe("event-3");

                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test("handles empty events array", async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getDatabase(capabilities);
                const iface = makeInterface(db);

                await iface.update([]);

                const result = await db.get("all_events");
                expect(result).toBeDefined();
                expect(result.value.events).toHaveLength(0);
                expect(result.isDirty).toBe(true);

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
                const db = await getDatabase(capabilities);
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
