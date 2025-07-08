const path = require("path");
const { readObjects } = require("../src/json_stream_file");
const temporary = require("./temporary");

beforeEach(temporary.beforeEach);
afterEach(temporary.afterEach);

async function getTestPath(capabilities) {
    const testDir = temporary.input();
    await capabilities.creator.createDirectory(testDir);
    return path.join(testDir, "test.json");
}

function getTestCapabilities() {
    const capabilities = {
        reader: require("../src/filesystem/reader").make(),
        checker: require("../src/filesystem/checker").make(),
        creator: require("../src/filesystem/creator").make(),
        writer: require("../src/filesystem/writer").make(),
    };
    return capabilities;
}

describe("json_stream_file", () => {
    it("should read a single JSON object from file", async () => {
        const capabilities = getTestCapabilities();
        const testFilePath = await getTestPath(capabilities);
        const testFileObj = await capabilities.creator.createFile(testFilePath);
        const testObject = { name: "test", value: 42 };
        await capabilities.writer.writeFile(
            testFileObj,
            JSON.stringify(testObject)
        );

        const objects = await readObjects(capabilities, testFileObj);
        expect(objects).toHaveLength(1);
        expect(objects[0]).toEqual(testObject);
    });

    it("should read multiple JSON objects from file (JSON Lines format)", async () => {
        const capabilities = getTestCapabilities();
        const testFilePath = await getTestPath(capabilities);
        const testFileObj = await capabilities.creator.createFile(testFilePath);
        const testObjects = [
            { name: "test1", value: 42 },
            { name: "test2", value: "hello" },
            { name: "test3", value: true },
        ];
        const content = testObjects
            .map((obj) => JSON.stringify(obj))
            .join("\n");
        await capabilities.writer.writeFile(testFileObj, content);

        const objects = await readObjects(capabilities, testFileObj);
        expect(objects).toHaveLength(3);
        expect(objects).toEqual(testObjects);
    });

    it("should handle empty file", async () => {
        const capabilities = getTestCapabilities();
        const testFilePath = await getTestPath(capabilities);
        const testFileObj = await capabilities.creator.createFile(testFilePath);
        await capabilities.writer.writeFile(testFileObj, "");

        const objects = await readObjects(capabilities, testFileObj);
        expect(objects).toHaveLength(0);
    });

    it("should reject on invalid JSON", async () => {
        const capabilities = getTestCapabilities();
        const testFilePath = await getTestPath(capabilities);
        const testFileObj = await capabilities.creator.createFile(testFilePath);
        await capabilities.writer.writeFile(testFileObj, "{ invalid json }");

        await expect(readObjects(capabilities, testFileObj)).rejects.toThrow();
    });

    it("should reject on non-existent file", async () => {
        const capabilities = getTestCapabilities();
        const testFilePath = await getTestPath(capabilities);
        await expect(
            capabilities.checker.instantiate(testFilePath)
        ).rejects.toThrow();
    });
});
