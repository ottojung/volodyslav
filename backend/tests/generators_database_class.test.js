/**
 * Tests for generators/database class.
 */

const { make: makeDatabase, isDatabase } = require("../src/generators/database/class");
const { isDatabaseError, isDatabaseInitializationError, isDatabaseQueryError } = require("../src/generators/database/errors");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger } = require("./stubs");
const path = require("path");
const fs = require("fs");
const os = require("os");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    return capabilities;
}

describe("generators/database/class", () => {
    let tmpDir;
    let testDbPath;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jest-db-"));
        testDbPath = path.join(tmpDir, "test.db");
    });

    afterEach(() => {
        // Clean up temporary directory
        if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test("makeDatabase creates database instance", async () => {
        const capabilities = getTestCapabilities();
        const database = await makeDatabase(capabilities, testDbPath);
        
        expect(database).toBeDefined();
        expect(isDatabase(database)).toBe(true);
        
        await database.close();
    });

    test("makeDatabase creates mirror tables", async () => {
        const capabilities = getTestCapabilities();
        const database = await makeDatabase(capabilities, testDbPath);
        
        // Check that events table exists
        const eventsTable = await database.get(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='events'"
        );
        expect(eventsTable).toBeDefined();
        expect(eventsTable.name).toBe("events");
        
        // Check that modifiers table exists
        const modifiersTable = await database.get(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='modifiers'"
        );
        expect(modifiersTable).toBeDefined();
        expect(modifiersTable.name).toBe("modifiers");
        
        await database.close();
    });

    test("events table has required columns", async () => {
        const capabilities = getTestCapabilities();
        const database = await makeDatabase(capabilities, testDbPath);
        
        const columns = await database.all("PRAGMA table_info(events)");
        const columnNames = columns.map(col => col.name);
        
        expect(columnNames).toContain("id");
        expect(columnNames).toContain("type");
        expect(columnNames).toContain("input");
        expect(columnNames).toContain("original");
        
        await database.close();
    });

    test("run method executes INSERT query", async () => {
        const capabilities = getTestCapabilities();
        const database = await makeDatabase(capabilities, testDbPath);
        
        await database.run(
            "INSERT INTO events (id, type, input, original) VALUES (?, ?, ?, ?)",
            ["test-id", "test-type", "test-input", "test-original"]
        );
        
        const row = await database.get("SELECT * FROM events WHERE id = ?", ["test-id"]);
        expect(row).toBeDefined();
        expect(row.id).toBe("test-id");
        expect(row.type).toBe("test-type");
        expect(row.input).toBe("test-input");
        expect(row.original).toBe("test-original");
        
        await database.close();
    });

    test("all method returns multiple rows", async () => {
        const capabilities = getTestCapabilities();
        const database = await makeDatabase(capabilities, testDbPath);
        
        await database.run(
            "INSERT INTO events (id, type, input, original) VALUES (?, ?, ?, ?)",
            ["id1", "type1", "input1", "original1"]
        );
        await database.run(
            "INSERT INTO events (id, type, input, original) VALUES (?, ?, ?, ?)",
            ["id2", "type2", "input2", "original2"]
        );
        
        const rows = await database.all("SELECT * FROM events ORDER BY id");
        expect(rows).toHaveLength(2);
        expect(rows[0].id).toBe("id1");
        expect(rows[1].id).toBe("id2");
        
        await database.close();
    });

    test("get method returns single row", async () => {
        const capabilities = getTestCapabilities();
        const database = await makeDatabase(capabilities, testDbPath);
        
        await database.run(
            "INSERT INTO events (id, type, input, original) VALUES (?, ?, ?, ?)",
            ["test-id", "test-type", "test-input", "test-original"]
        );
        
        const row = await database.get("SELECT * FROM events WHERE id = ?", ["test-id"]);
        expect(row).toBeDefined();
        expect(row.id).toBe("test-id");
        
        await database.close();
    });

    test("get method returns undefined for non-existent row", async () => {
        const capabilities = getTestCapabilities();
        const database = await makeDatabase(capabilities, testDbPath);
        
        const row = await database.get("SELECT * FROM events WHERE id = ?", ["non-existent"]);
        expect(row).toBeUndefined();
        
        await database.close();
    });

    test("run method with invalid SQL throws DatabaseQueryError", async () => {
        const capabilities = getTestCapabilities();
        const database = await makeDatabase(capabilities, testDbPath);
        
        await expect(database.run("INVALID SQL")).rejects.toThrow();
        const error = await database.run("INVALID SQL").catch(e => e);
        expect(isDatabaseQueryError(error)).toBe(true);
        expect(error.query).toBe("INVALID SQL");
        
        await database.close();
    });

    test("all method with invalid SQL throws DatabaseQueryError", async () => {
        const capabilities = getTestCapabilities();
        const database = await makeDatabase(capabilities, testDbPath);
        
        await expect(database.all("INVALID SQL")).rejects.toThrow();
        const error = await database.all("INVALID SQL").catch(e => e);
        expect(isDatabaseQueryError(error)).toBe(true);
        
        await database.close();
    });

    test("get method with invalid SQL throws DatabaseQueryError", async () => {
        const capabilities = getTestCapabilities();
        const database = await makeDatabase(capabilities, testDbPath);
        
        await expect(database.get("INVALID SQL")).rejects.toThrow();
        const error = await database.get("INVALID SQL").catch(e => e);
        expect(isDatabaseQueryError(error)).toBe(true);
        
        await database.close();
    });

    test("close method closes database connection", async () => {
        const capabilities = getTestCapabilities();
        const database = await makeDatabase(capabilities, testDbPath);
        
        await expect(database.close()).resolves.not.toThrow();
    });

    test("makeDatabase creates directory if it doesn't exist", async () => {
        const capabilities = getTestCapabilities();
        const newDir = path.join(tmpDir, "newdir");
        const newDbPath = path.join(newDir, "test.db");
        
        const database = await makeDatabase(capabilities, newDbPath);
        
        expect(fs.existsSync(newDir)).toBe(true);
        expect(fs.existsSync(newDbPath)).toBe(true);
        
        await database.close();
    });

    test("makeDatabase with invalid path throws DatabaseInitializationError", async () => {
        const capabilities = getTestCapabilities();
        // Use a path that will cause an error (e.g., null byte in path)
        const invalidPath = path.join(tmpDir, "\0invalid");
        
        await expect(makeDatabase(capabilities, invalidPath)).rejects.toThrow();
        const error = await makeDatabase(capabilities, invalidPath).catch(e => e);
        expect(isDatabaseInitializationError(error)).toBe(true);
    });

    test("database persists data across connections", async () => {
        const capabilities = getTestCapabilities();
        
        // First connection: insert data
        let database = await makeDatabase(capabilities, testDbPath);
        await database.run(
            "INSERT INTO events (id, type, input, original) VALUES (?, ?, ?, ?)",
            ["persist-id", "persist-type", "persist-input", "persist-original"]
        );
        await database.close();
        
        // Second connection: verify data persists
        database = await makeDatabase(capabilities, testDbPath);
        const row = await database.get("SELECT * FROM events WHERE id = ?", ["persist-id"]);
        expect(row).toBeDefined();
        expect(row.id).toBe("persist-id");
        await database.close();
    });

    test("type guard isDatabase returns false for non-Database objects", () => {
        expect(isDatabase({})).toBe(false);
        expect(isDatabase(null)).toBe(false);
        expect(isDatabase(undefined)).toBe(false);
        expect(isDatabase("not a database")).toBe(false);
    });

    test("DatabaseError type guards work correctly", () => {
        const { DatabaseError } = require("../src/generators/database/errors");
        const dbError = new DatabaseError("test error", "/test/path");
        
        expect(isDatabaseError(dbError)).toBe(true);
        expect(isDatabaseError(new Error("regular error"))).toBe(false);
    });
});
