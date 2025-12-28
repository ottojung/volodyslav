/**
 * Tests for generators/dependency_graph module.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { get: getDatabase } = require("../src/generators/database");
const {
    makeDependencyGraph,
    isDependencyGraph,
} = require("../src/generators/dependency_graph");
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
        path.join(os.tmpdir(), "dependency-graph-test-")
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

describe("generators/dependency_graph", () => {
    describe("makeDependencyGraph()", () => {
        test("creates and returns a dependency graph instance", async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getDatabase(capabilities);
                const graph = makeDependencyGraph(db);

                expect(isDependencyGraph(graph)).toBe(true);

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
                const graph = makeDependencyGraph(db);

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

                await graph.update(events);

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
                const graph = makeDependencyGraph(db);

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

                await graph.update(firstEvents);
                await graph.update(secondEvents);

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
                const graph = makeDependencyGraph(db);

                await graph.update([]);

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
        test("isDependencyGraph correctly identifies instances", async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getDatabase(capabilities);
                const graph = makeDependencyGraph(db);

                expect(isDependencyGraph(graph)).toBe(true);
                expect(isDependencyGraph({})).toBe(false);
                expect(isDependencyGraph(null)).toBe(false);
                expect(isDependencyGraph(undefined)).toBe(false);

                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });
    });
});
