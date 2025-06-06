const fs = require("fs").promises;
const path = require("path");
const { readObjects } = require("../src/json_stream_file");
const temporary = require("./temporary");

beforeEach(temporary.beforeEach);
afterEach(temporary.afterEach);

async function getTestPath() {
    const testDir = temporary.input();
    await fs.mkdir(testDir, { recursive: true });
    return path.join(testDir, "test.json");
}

function getTestCapabilities() {
    const capabilities = {
        reader: require("../src/filesystem/reader").make(),
        checker: require("../src/filesystem/checker").make(),
    };
    return capabilities;
}

describe("json_stream_file", () => {
    it("should read a single JSON object from file", async () => {
        const testFile = await getTestPath();
        const capabilities = getTestCapabilities();
        const testObject = { name: "test", value: 42 };
        await fs.writeFile(testFile, JSON.stringify(testObject));

        const testFileObj = await capabilities.checker.instantiate(testFile);
        const objects = await readObjects(capabilities, testFileObj);
        expect(objects).toHaveLength(1);
        expect(objects[0]).toEqual(testObject);
    });

    it("should read multiple JSON objects from file (JSON Lines format)", async () => {
        const testFile = await getTestPath();
        const capabilities = getTestCapabilities();
        const testObjects = [
            { name: "test1", value: 42 },
            { name: "test2", value: "hello" },
            { name: "test3", value: true },
        ];
        const content = testObjects
            .map((obj) => JSON.stringify(obj))
            .join("\n");
        await fs.writeFile(testFile, content);

        const testFileObj = await capabilities.checker.instantiate(testFile);
        const objects = await readObjects(capabilities, testFileObj);
        expect(objects).toHaveLength(3);
        expect(objects).toEqual(testObjects);
    });

    it("should handle empty file", async () => {
        const testFile = await getTestPath();
        const capabilities = getTestCapabilities();
        await fs.writeFile(testFile, "");

        const testFileObj = await capabilities.checker.instantiate(testFile);
        const objects = await readObjects(capabilities, testFileObj);
        expect(objects).toHaveLength(0);
    });

    it("should reject on invalid JSON", async () => {
        const testFile = await getTestPath();
        const capabilities = getTestCapabilities();
        await fs.writeFile(testFile, "{ invalid json }");

        const testFileObj = await capabilities.checker.instantiate(testFile);
        await expect(readObjects(capabilities, testFileObj)).rejects.toThrow();
    });

    it("should reject on non-existent file", async () => {
        const testFile = await getTestPath();
        const capabilities = getTestCapabilities();
        await expect(
            capabilities.checker.instantiate(testFile)
        ).rejects.toThrow();
    });
});
