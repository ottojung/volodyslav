const path = require("path");
const { transaction } = require("../src/event_log_storage");
const { targetPath } = require("../src/event/asset");
const { makeFromBuffer, makeFromData } = require("../src/filesystem/file_ref");
const { fromISOString } = require("../src/datetime");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime } = require("./stubs");
const fsp = require("fs/promises");

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

function makeAsset(event, filename, content = "test content") {
    return {
        event,
        file: makeFromBuffer(filename, Buffer.from(content)),
    };
}

function makeBadAsset(event, filename) {
    return {
        event,
        file: makeFromData(filename, () =>
            Promise.reject(new Error(`file not found: ${filename}`))
        ),
    };
}

describe("event_log_storage assets", () => {
    test("copies asset files into the assets directory", async () => {
        const capabilities = getTestCapabilities();
        const testEvent = makeEvent("asset-event");
        const asset = makeAsset(testEvent, "asset.txt");

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
        const goodAsset = makeAsset(testEvent, "good.txt");
        const badAsset = makeBadAsset(testEvent, "bad.txt");

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
