const path = require("path");
const fsp = require("fs/promises");
const { transaction } = require("../src/local_data");
const { targetPath } = require("../src/event/asset");
const { fromISOString } = require("../src/datetime");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

function makeEvent(id) {
    return {
        id: { identifier: id },
        date: fromISOString("2025-05-13T00:00:00.000Z"),
        creator: { name: "test", uuid: "uuid", version: "1.0.0", hostname: "test-host" },
    };
}

async function makeAsset(capabilities, event, filename, content = "test content") {
    const inputDir = await capabilities.creator.createTemporaryDirectory(capabilities);
    const sourcePath = path.join(inputDir, filename);
    await fsp.mkdir(inputDir, { recursive: true });
    await fsp.writeFile(sourcePath, content);
    return {
        event,
        file: { path: sourcePath, __brand: "ExistingFile" },
    };
}

describe("local_data assets", () => {
    test("copies asset files into the assets directory", async () => {
        const capabilities = getTestCapabilities();
        const testEvent = makeEvent("asset-event");
        const asset = await makeAsset(capabilities, testEvent, "asset.txt");

        await transaction(capabilities, async (storage) => {
            storage.addEntry(testEvent, [asset]);
        });

        const target = targetPath(capabilities, asset);
        await expect(fsp.stat(path.dirname(target))).resolves.toBeDefined();
        await expect(fsp.stat(target)).resolves.toBeDefined();
        await expect(capabilities.interface.getAllEvents()).resolves.toHaveLength(1);
    });

    test("cleans up copied assets and leaves graph entries unchanged on failure", async () => {
        const capabilities = getTestCapabilities();
        const testEvent = makeEvent("cleanup-event");
        const goodAsset = await makeAsset(capabilities, testEvent, "good.txt");
        const badAsset = {
            event: testEvent,
            file: { path: "/missing/file.txt", __brand: "ExistingFile" },
        };

        await expect(
            transaction(capabilities, async (storage) => {
                storage.addEntry(testEvent, [goodAsset, badAsset]);
            })
        ).rejects.toThrow();

        expect(capabilities.deleter.deleteFile).toHaveBeenCalledWith(
            targetPath(capabilities, goodAsset)
        );
        await expect(capabilities.interface.getAllEvents()).resolves.toEqual([]);
    });
});
