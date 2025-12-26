/**
 * Tests for generators/database index (get function).
 */

const { get } = require("../src/generators/database");
const { isDatabase } = require("../src/generators/database/class");
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

describe("generators/database/index", () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jest-db-"));
    });

    afterEach(() => {
        // Clean up temporary directory
        if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test("get returns database instance", async () => {
        const capabilities = getTestCapabilities();
        
        // Override workingDirectory to use our temp dir
        capabilities.environment.workingDirectory = jest.fn().mockReturnValue(tmpDir);
        
        const database = await get(capabilities);
        
        expect(database).toBeDefined();
        expect(isDatabase(database)).toBe(true);
        
        await database.close();
    });

    test("get creates database in working directory", async () => {
        const capabilities = getTestCapabilities();
        capabilities.environment.workingDirectory = jest.fn().mockReturnValue(tmpDir);
        
        const database = await get(capabilities);
        
        const expectedPath = path.join(tmpDir, "generators.db");
        expect(fs.existsSync(expectedPath)).toBe(true);
        
        await database.close();
    });

    test("get creates database with mirror tables", async () => {
        const capabilities = getTestCapabilities();
        capabilities.environment.workingDirectory = jest.fn().mockReturnValue(tmpDir);
        
        const database = await get(capabilities);
        
        // Verify events table exists
        const eventsTable = await database.get(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='events'"
        );
        expect(eventsTable).toBeDefined();
        
        // Verify modifiers table exists
        const modifiersTable = await database.get(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='modifiers'"
        );
        expect(modifiersTable).toBeDefined();
        
        await database.close();
    });

    test("get can be called multiple times and returns working database", async () => {
        const capabilities = getTestCapabilities();
        capabilities.environment.workingDirectory = jest.fn().mockReturnValue(tmpDir);
        
        const database1 = await get(capabilities);
        await database1.run(
            "INSERT INTO events (id, type, input, original) VALUES (?, ?, ?, ?)",
            ["test1", "type1", "input1", "original1"]
        );
        await database1.close();
        
        const database2 = await get(capabilities);
        const row = await database2.get("SELECT * FROM events WHERE id = ?", ["test1"]);
        expect(row).toBeDefined();
        expect(row.id).toBe("test1");
        await database2.close();
    });

    test("database from get has functional run method", async () => {
        const capabilities = getTestCapabilities();
        capabilities.environment.workingDirectory = jest.fn().mockReturnValue(tmpDir);
        
        const database = await get(capabilities);
        
        await expect(
            database.run(
                "INSERT INTO events (id, type, input, original) VALUES (?, ?, ?, ?)",
                ["func-test", "type", "input", "original"]
            )
        ).resolves.not.toThrow();
        
        await database.close();
    });

    test("database from get has functional all method", async () => {
        const capabilities = getTestCapabilities();
        capabilities.environment.workingDirectory = jest.fn().mockReturnValue(tmpDir);
        
        const database = await get(capabilities);
        
        await database.run(
            "INSERT INTO events (id, type, input, original) VALUES (?, ?, ?, ?)",
            ["all-test1", "type", "input", "original"]
        );
        await database.run(
            "INSERT INTO events (id, type, input, original) VALUES (?, ?, ?, ?)",
            ["all-test2", "type", "input", "original"]
        );
        
        const rows = await database.all("SELECT * FROM events");
        expect(rows.length).toBeGreaterThanOrEqual(2);
        
        await database.close();
    });

    test("database from get has functional get method", async () => {
        const capabilities = getTestCapabilities();
        capabilities.environment.workingDirectory = jest.fn().mockReturnValue(tmpDir);
        
        const database = await get(capabilities);
        
        await database.run(
            "INSERT INTO events (id, type, input, original) VALUES (?, ?, ?, ?)",
            ["get-test", "type", "input", "original"]
        );
        
        const row = await database.get("SELECT * FROM events WHERE id = ?", ["get-test"]);
        expect(row).toBeDefined();
        expect(row.id).toBe("get-test");
        
        await database.close();
    });
});
