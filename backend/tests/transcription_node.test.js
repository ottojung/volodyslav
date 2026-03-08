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
 * Writes a diary event with attached asset files and returns their paths relative
 * to the assets root.
 *
 * @param {object} capabilities
 * @param {string} eventId
 * @param {Array<string>} filenames
 * @returns {Promise<Array<string>>}
 */
async function writeDiaryEventWithAssets(capabilities, eventId, filenames) {
    const diaryEvent = makeDiaryEvent(eventId);
    const tmpDir = await capabilities.creator.createTemporaryDirectory(capabilities);
    const assets = [];

    for (const filename of filenames) {
        const sourcePath = path.join(tmpDir, filename);
        const sourceFile = await capabilities.creator.createFile(sourcePath);
        await capabilities.writer.writeFile(sourceFile, "fake file");
        assets.push(event.asset.make(diaryEvent, sourceFile));
    }

    await transaction(capabilities, async (storage) => {
        storage.addEntry(diaryEvent, assets);
    });

    return assets.map((asset) => {
        return path.relative(
            capabilities.environment.eventLogAssetsDirectory(),
            event.asset.targetPath(capabilities, asset),
        );
    });
}

describe("transcription(a) node", () => {
    test("transcribes a valid audio file path", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const [relativeAssetPath] = await writeDiaryEventWithAssets(
            capabilities,
            "1",
            ["memo.mp3"],
        );
        await iface.update();

        const result = await iface._incrementalGraph.pull(
            "transcription",
            [relativeAssetPath],
        );

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
            ),
        );
    });

    test("caches the result on repeated pulls", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const [relativeAssetPath] = await writeDiaryEventWithAssets(
            capabilities,
            "1",
            ["memo.mp3"],
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
        await iface.update();

        await expect(
            iface._incrementalGraph.pull("transcription", ["../escape.mp3"])
        ).rejects.toThrow("Invalid asset path for transcription: ../escape.mp3");
        expect(capabilities.aiTranscription.transcribeStream).not.toHaveBeenCalled();
    });
});

describe("event_transcription(e, a) node", () => {
    test("returns the event and transcription for a matching audio path", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const [relativeAssetPath] = await writeDiaryEventWithAssets(
            capabilities,
            "1",
            ["memo.mp3"],
        );
        await iface.update();

        const result = await iface._incrementalGraph.pull(
            "event_transcription",
            ["1", relativeAssetPath],
        );

        expect(result).toMatchObject({
            type: "event_transcription",
            event: expect.objectContaining({
                id: expect.any(Object),
            }),
            transcription: expect.objectContaining({
                text: "mocked transcription result",
            }),
        });
        expect(capabilities.aiTranscription.transcribeStream).toHaveBeenCalledTimes(1);
    });

    test("rejects when the audio path does not belong to the event", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        // Create two events with their own audio files
        const [audioPath1] = await writeDiaryEventWithAssets(capabilities, "1", ["memo1.mp3"]);
        const [audioPath2] = await writeDiaryEventWithAssets(capabilities, "2", ["memo2.mp3"]);
        void audioPath1;
        await iface.update();

        // Attempt to combine event "1" with event "2"'s audio path
        await expect(
            iface._incrementalGraph.pull("event_transcription", ["1", audioPath2])
        ).rejects.toThrow(`Audio path ${audioPath2} is not associated with event 1`);
    });

    test("caches the result on repeated pulls", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        const [relativeAssetPath] = await writeDiaryEventWithAssets(
            capabilities,
            "1",
            ["memo.mp3"],
        );
        await iface.update();

        const first = await iface._incrementalGraph.pull("event_transcription", ["1", relativeAssetPath]);
        const second = await iface._incrementalGraph.pull("event_transcription", ["1", relativeAssetPath]);

        expect(first).toMatchObject({ type: "event_transcription" });
        expect(second).toMatchObject({ type: "event_transcription" });
        expect(capabilities.aiTranscription.transcribeStream).toHaveBeenCalledTimes(1);
    });
});
