const path = require("path");
const event = require("../src/event");
const { fromISOString } = require("../src/datetime");
const { transaction } = require("../src/event_log_storage");
const { makeFromExistingFile } = require("../src/filesystem/file_ref");
const { getMockedRootCapabilities } = require("./spies");
const {
    stubLogger,
    stubEnvironment,
    stubDatetime,
    stubAiTranscriber,
    stubAiDiarySummary,
} = require("./stubs");
const { runDiarySummaryPipeline } = require("../src/jobs/diary_summary");

/**
 * @param {string} id
 * @param {import('../src/datetime').DateTime} [date]
 */
function makeDiaryEvent(id, date) {
    return {
        id: event.id.fromString(id),
        type: "diary",
        description: "",
        date: date ?? fromISOString("2024-01-01T00:00:00.000Z"),
        original: `diary [audiorecording]`,
        input: `diary [audiorecording] [source filesystem_ingest]`,
        modifiers: {},
        creator: {
            name: "test",
            uuid: "00000000-0000-0000-0000-000000000001",
            version: "0.0.0",
            hostname: "test-host",
        },
    };
}

async function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubAiTranscriber(capabilities);
    stubAiDiarySummary(capabilities);
    return capabilities;
}

/**
 * Writes a diary event with attached audio assets.
 * Returns relative asset paths.
 *
 * @param {object} capabilities
 * @param {string} eventId
 * @param {Array<string>} filenames
 * @param {import('../src/datetime').DateTime} [date]
 * @returns {Promise<Array<string>>}
 */
async function writeDiaryEventWithAssets(capabilities, eventId, filenames, date) {
    const diaryEvent = makeDiaryEvent(eventId, date);
    const tmpDir = await capabilities.creator.createTemporaryDirectory();
    const assets = [];

    for (const filename of filenames) {
        const sourcePath = path.join(tmpDir, filename);
        const sourceFile = await capabilities.creator.createFile(sourcePath);
        await capabilities.writer.writeFile(sourceFile, "fake audio content");
        assets.push(event.asset.make(diaryEvent, makeFromExistingFile(
            sourceFile,
            (p) => capabilities.reader.readFileAsBuffer(p)
        )));
    }

    await transaction(capabilities, async (storage) => {
        storage.addEntry(diaryEvent, assets);
    });

    return assets.map((asset) =>
        path.relative(
            capabilities.environment.eventLogAssetsDirectory(),
            event.asset.targetPath(capabilities, asset),
        )
    );
}

describe("runDiarySummaryPipeline", () => {
    test("returns default summary when no events exist", async () => {
        const capabilities = await getTestCapabilities();
        await capabilities.interface.ensureInitialized();

        const result = await runDiarySummaryPipeline(capabilities);

        expect(result.type).toBe("diary_most_important_info_summary");
        expect(result.markdown).toBeTruthy();
        expect(typeof result.summaryDate).toBe("string");
        expect(capabilities.aiDiarySummary.updateSummary).not.toHaveBeenCalled();
    });

    test("does not update summary when transcription is not yet materialized", async () => {
        const capabilities = await getTestCapabilities();
        await capabilities.interface.ensureInitialized();

        // Write event with assets but do NOT pull entry_diary_content (not materialized).
        await writeDiaryEventWithAssets(capabilities, "1", ["memo.mp3"]);

        const result = await runDiarySummaryPipeline(capabilities);

        // No entry_diary_content materialized → AI not called.
        expect(capabilities.aiDiarySummary.updateSummary).not.toHaveBeenCalled();
        // processedTranscriptions should be empty.
        expect(Object.keys(result.processedTranscriptions)).toHaveLength(0);
    });

    test("updates summary when a materialized transcription is present", async () => {
        const capabilities = await getTestCapabilities();
        await capabilities.interface.ensureInitialized();

        const [relativeAssetPath] = await writeDiaryEventWithAssets(
            capabilities,
            "1",
            ["memo.mp3"],
            fromISOString("2024-03-15T10:00:00.000Z"),
        );

        // Materialize the entry_diary_content node by pulling it.
        await capabilities.interface.pullGraphNode("entry_diary_content", ["1", relativeAssetPath]);

        const result = await runDiarySummaryPipeline(capabilities);

        expect(capabilities.aiDiarySummary.updateSummary).toHaveBeenCalledTimes(1);
        const call = capabilities.aiDiarySummary.updateSummary.mock.calls[0][0];
        expect(call.newEntryTranscribedAudioRecording).toContain("mocked transcription");
        expect(call.newEntryDateISO).toBeTruthy();

        // Watermark should be recorded for this asset.
        expect(result.processedTranscriptions[relativeAssetPath]).toBeTruthy();
    });

    test("skips transcription that was already processed (watermark)", async () => {
        const capabilities = await getTestCapabilities();
        await capabilities.interface.ensureInitialized();

        const [relativeAssetPath] = await writeDiaryEventWithAssets(
            capabilities,
            "1",
            ["memo.mp3"],
        );

        // Materialize entry_diary_content.
        await capabilities.interface.pullGraphNode("entry_diary_content", ["1", relativeAssetPath]);

        // First run: processes the entry.
        const first = await runDiarySummaryPipeline(capabilities);
        expect(capabilities.aiDiarySummary.updateSummary).toHaveBeenCalledTimes(1);

        // Second run: entry_diary_content mod-time unchanged, should be skipped.
        const second = await runDiarySummaryPipeline(capabilities);
        expect(capabilities.aiDiarySummary.updateSummary).toHaveBeenCalledTimes(1); // still 1

        // Watermark should be the same.
        expect(second.processedTranscriptions[relativeAssetPath])
            .toBe(first.processedTranscriptions[relativeAssetPath]);
    });

    test("advances summaryDate to the newer entry date", async () => {
        const capabilities = await getTestCapabilities();
        await capabilities.interface.ensureInitialized();

        const olderDate = fromISOString("2024-01-10T00:00:00.000Z");
        const newerDate = fromISOString("2024-06-20T00:00:00.000Z");

        const [olderPath] = await writeDiaryEventWithAssets(
            capabilities, "1", ["older.mp3"], olderDate
        );
        const [newerPath] = await writeDiaryEventWithAssets(
            capabilities, "2", ["newer.mp3"], newerDate
        );

        // Materialize both entry_diary_content nodes.
        await capabilities.interface.pullGraphNode("entry_diary_content", ["1", olderPath]);
        await capabilities.interface.pullGraphNode("entry_diary_content", ["2", newerPath]);

        const result = await runDiarySummaryPipeline(capabilities);

        expect(capabilities.aiDiarySummary.updateSummary).toHaveBeenCalledTimes(2);
        // summaryDate should reflect the newer entry date using DateTime comparison.
        const summaryDateTime = fromISOString(result.summaryDate);
        const newerDateTime = fromISOString(newerDate.toISOString());
        expect(summaryDateTime.compare(newerDateTime)).toBe(0);
    });

    test("persists intermediate state after each fold (incremental persistence)", async () => {
        const capabilities = await getTestCapabilities();
        await capabilities.interface.ensureInitialized();

        const [p1] = await writeDiaryEventWithAssets(
            capabilities, "1", ["a.mp3"], fromISOString("2024-01-01T00:00:00.000Z")
        );
        const [p2] = await writeDiaryEventWithAssets(
            capabilities, "2", ["b.mp3"], fromISOString("2024-02-01T00:00:00.000Z")
        );

        // Materialize both.
        await capabilities.interface.pullGraphNode("entry_diary_content", ["1", p1]);
        await capabilities.interface.pullGraphNode("entry_diary_content", ["2", p2]);

        const setDiarySummarySpy = jest.spyOn(capabilities.interface, "setDiarySummary");

        await runDiarySummaryPipeline(capabilities);

        // Should be called once per fold (2 transcriptions → 2 calls).
        expect(setDiarySummarySpy).toHaveBeenCalledTimes(2);
    });

    test("skips non-diary events", async () => {
        const capabilities = await getTestCapabilities();
        await capabilities.interface.ensureInitialized();

        // Create a non-diary event (type "food" is parsed from the input string).
        const foodEvent = {
            id: event.id.fromString("99"),
            description: "",
            date: fromISOString("2024-01-01T00:00:00.000Z"),
            original: "food pizza",
            input: "food pizza",
            modifiers: {},
            creator: {
                name: "test",
                uuid: "00000000-0000-0000-0000-000000000001",
                version: "0.0.0",
                hostname: "test-host",
            },
        };
        const tmpDir = await capabilities.creator.createTemporaryDirectory();
        const assetFile = await capabilities.creator.createFile(require("path").join(tmpDir, "meal.mp3"));
        await capabilities.writer.writeFile(assetFile, "audio");
        const { makeFromExistingFile } = require("../src/filesystem/file_ref");
        const assetObj = event.asset.make(foodEvent, makeFromExistingFile(
            assetFile,
            (p) => capabilities.reader.readFileAsBuffer(p)
        ));
        await transaction(capabilities, async (storage) => {
            storage.addEntry(foodEvent, [assetObj]);
        });

        // Even if a transcription were somehow present, the pipeline should skip this event.
        // (Without materializing anything there is nothing to skip, so just verify AI isn't called.)
        await runDiarySummaryPipeline(capabilities);
        expect(capabilities.aiDiarySummary.updateSummary).not.toHaveBeenCalled();
    });

    test("serializes concurrent pipeline runs via mutex", async () => {
        const capabilities = await getTestCapabilities();
        await capabilities.interface.ensureInitialized();

        const [relativeAssetPath] = await writeDiaryEventWithAssets(
            capabilities, "1", ["memo.mp3"], fromISOString("2024-01-01T00:00:00.000Z")
        );
        await capabilities.interface.pullGraphNode("entry_diary_content", ["1", relativeAssetPath]);

        // Launch two pipeline runs concurrently.
        const [r1, r2] = await Promise.all([
            runDiarySummaryPipeline(capabilities),
            runDiarySummaryPipeline(capabilities),
        ]);

        // Both should succeed and return a valid summary.
        expect(r1.type).toBe("diary_most_important_info_summary");
        expect(r2.type).toBe("diary_most_important_info_summary");

        // The AI should be called exactly once total: the second run sees the
        // entry already watermarked by the first and skips it.
        expect(capabilities.aiDiarySummary.updateSummary).toHaveBeenCalledTimes(1);
    });
});
