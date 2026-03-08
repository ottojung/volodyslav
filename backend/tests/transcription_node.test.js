const path = require("path");
const event = require("../src/event");
const { fromISOString } = require("../src/datetime");
const { transaction } = require("../src/event_log_storage");
const { getMockedRootCapabilities } = require("./spies");
const {
    stubLogger,
    stubEnvironment,
    stubDatetime,
    stubEventLogRepository,
    stubAiTranscriber,
} = require("./stubs");

function makeDiaryEvent(id) {
    return {
        id: event.id.fromString(id),
        type: "diary",
        description: "",
        date: fromISOString("2024-01-01T00:00:00.000Z"),
        original: "diary [when 0 hours ago] [audiorecording]",
        input: "diary [when 0 hours ago] [audiorecording]",
        modifiers: {
            when: "0 hours ago",
            audiorecording: "",
        },
        creator: {
            name: "test",
            uuid: "00000000-0000-0000-0000-000000000001",
            version: "0.0.0",
        },
    };
}

async function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    await stubEventLogRepository(capabilities);
    stubAiTranscriber(capabilities);
    return capabilities;
}

/**
 * @param {object} capabilities
 * @param {string} eventId
 * @param {string} filename
 * @returns {Promise<string>}
 */
async function writeDiaryEventWithAsset(capabilities, eventId, filename) {
    const tmpDir = await capabilities.creator.createTemporaryDirectory(capabilities);
    const sourcePath = path.join(tmpDir, filename);
    const sourceFile = await capabilities.creator.createFile(sourcePath);
    await capabilities.writer.writeFile(sourceFile, "fake audio");

    const diaryEvent = makeDiaryEvent(eventId);
    const asset = event.asset.make(diaryEvent, sourceFile);
    await transaction(capabilities, async (storage) => {
        storage.addEntry(diaryEvent, [asset]);
    });

    return path.relative(
        capabilities.environment.eventLogAssetsDirectory(),
        event.asset.targetPath(capabilities, asset),
    );
}

describe("transcription(a) node", () => {
    test("transcribes an event asset path relative to the assets root", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const relativeAssetPath = await writeDiaryEventWithAsset(
            capabilities,
            "1",
            "memo.mp3",
        );
        await iface.update();

        const result = await iface._incrementalGraph.pull("transcription", [relativeAssetPath]);

        expect(result).toMatchObject({
            type: "transcription",
            value: {
                text: "mocked transcription result",
                transcriber: {
                    name: "mocked-transcriber",
                    creator: "Mocked Creator",
                },
                creator: expect.any(Object),
            },
        });
        expect(capabilities.aiTranscription.transcribeStream).toHaveBeenCalledTimes(1);
        expect(capabilities.aiTranscription.transcribeStream.mock.calls[0][0].path).toBe(
            path.join(
                capabilities.environment.eventLogAssetsDirectory(),
                relativeAssetPath,
            )
        );
    });

    test("returns cached value for repeated pulls without updates", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const relativeAssetPath = await writeDiaryEventWithAsset(
            capabilities,
            "1",
            "memo.mp3",
        );
        await iface.update();

        const first = await iface._incrementalGraph.pull("transcription", [relativeAssetPath]);
        const second = await iface._incrementalGraph.pull("transcription", [relativeAssetPath]);

        expect(first).toEqual(second);
        expect(capabilities.aiTranscription.transcribeStream).toHaveBeenCalledTimes(1);
    });

    test("rejects paths that escape the assets root", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        await expect(
            iface._incrementalGraph.pull("transcription", ["../escape.mp3"])
        ).rejects.toThrow("Invalid asset path for transcription: ../escape.mp3");
        expect(capabilities.aiTranscription.transcribeStream).not.toHaveBeenCalled();
    });

    test("rejects asset paths that do not match any event in all_events", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();
        await iface.update();

        await expect(
            iface._incrementalGraph.pull("transcription", ["2024-01/01/999/memo.mp3"])
        ).rejects.toThrow("No event found for asset path 2024-01/01/999/memo.mp3");
        expect(capabilities.aiTranscription.transcribeStream).not.toHaveBeenCalled();
    });
});
