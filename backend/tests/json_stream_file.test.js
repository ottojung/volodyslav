const fs = require("fs").promises;
const os = require("os");
const path = require("path");
const { readObjects } = require("../src/json_stream_file");

describe("json_stream_file", () => {
    const testDir = path.join(os.tmpdir(), "json_stream_file_test");
    const testFile = path.join(testDir, "test.json");

    beforeAll(async () => {
        await fs.mkdir(testDir, { recursive: true });
    });

    afterAll(async () => {
        await fs.rm(testDir, { recursive: true, force: true });
    });

    beforeEach(async () => {
        // Clean up test file before each test
        try {
            await fs.unlink(testFile);
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
    });

    it("should read a single JSON object from file", async () => {
        const testObject = { name: "test", value: 42 };
        await fs.writeFile(testFile, JSON.stringify(testObject));

        const objects = await readObjects(testFile);
        expect(objects).toHaveLength(1);
        expect(objects[0]).toEqual(testObject);
    });

    it("should read multiple JSON objects from file (JSON Lines format)", async () => {
        const testObjects = [
            { name: "test1", value: 42 },
            { name: "test2", value: "hello" },
            { name: "test3", value: true }
        ];
        
        const content = testObjects.map(obj => JSON.stringify(obj)).join("\n");
        await fs.writeFile(testFile, content);

        const objects = await readObjects(testFile);
        expect(objects).toHaveLength(3);
        expect(objects).toEqual(testObjects);
    });

    it("should handle empty file", async () => {
        await fs.writeFile(testFile, "");

        const objects = await readObjects(testFile);
        expect(objects).toHaveLength(0);
    });

    it("should reject on invalid JSON", async () => {
        await fs.writeFile(testFile, "{ invalid json }");

        await expect(readObjects(testFile)).rejects.toThrow();
    });

    it("should reject on non-existent file", async () => {
        const nonExistentFile = path.join(testDir, "non-existent.json");
        await expect(readObjects(nonExistentFile)).rejects.toThrow();
    });
});
