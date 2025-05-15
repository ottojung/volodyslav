// backend/tests/diary.test.js

// This test verifies that `processDiaryAudios` correctly handles transcription
// results by copying successful audio files, removing originals, logging failures,
// and recording events in the event log. It uses mocks to simulate file operations,
// transcription outputs, and the event-log API.

jest.mock("fs/promises", () => ({
    // Mock file operations to spy on readdir, copyFile and unlink calls
    readdir: jest.fn(),
}));

// Mock environment functions to provide fixed diary and assets directories
jest.mock("../src/environment", () => ({
    diaryAudiosDirectory: jest.fn(),
    eventLogAssetsDirectory: jest.fn(),
}));

// Mock the logger to capture error logging without printing to console
jest.mock("../src/creator", () => () => ({
    name: "Volodyslav",
    version: "0.1.0",
}));

// Mock the timestamp formatter for predictable date strings
jest.mock("../src/format_time_stamp", () => ({
    formatFileTimestamp: jest.fn(),
}));

// Mock the transaction API of event_log_storage to capture added entries
jest.mock("../src/event_log_storage", () => ({
    transaction: jest.fn(),
}));

// Mock the logger to capture error logging without printing to console
jest.mock("../src/logger", () => ({
    logError: jest.fn(),
    logWarning: jest.fn(),
    logInfo: jest.fn(),
}));

const { processDiaryAudios } = require("../src/diary");
const { readdir } = require("fs/promises");
const {
    diaryAudiosDirectory,
    eventLogAssetsDirectory,
} = require("../src/environment");
const { formatFileTimestamp } = require("../src/format_time_stamp");
const { transaction } = require("../src/event_log_storage");
const { logError } = require("../src/logger");
const random = require("../src/random");

describe("processDiaryAudios", () => {
    let storage;
    // Reset mocks and prepare a fake storage for event entries
    beforeEach(() => {
        jest.resetAllMocks();
        storage = { addEntry: jest.fn() };
        // Provide fixed directory paths for diary audios and assets
        diaryAudiosDirectory.mockReturnValue("/fake/diaryDir");
        eventLogAssetsDirectory.mockReturnValue("/fake/assetsDir");
        // Ensure formatted filename timestamps are predictable
        formatFileTimestamp.mockReturnValue(new Date("2025-05-12"));
        // Simulate directory entries and copy behaviour
        const filenames = ["file1.mp3", "file2.mp3", "bad.mp3"];
        readdir.mockResolvedValue(filenames);
        // Use the mock transaction to invoke callback with our fake storage
        transaction.mockImplementation(async (_deleter, cb) => {
            await cb(storage);
        });
    });

    it("should process diary audios correctly", async () => {
        // Mock the file deleter and random generator
        const deleter = { delete: jest.fn() };
        const rng = random.default_generator(42);
        // Invoke the processing function under test
        await processDiaryAudios(deleter, rng);

        // Verify that no errors are logged since writeAsset always succeeds
        expect(logError).not.toHaveBeenCalled();

        // Verify that writeAsset called transaction and added entries for all files
        expect(transaction).toHaveBeenCalledTimes(3);

        // Verify original files are removed after processing all files
        expect(deleter.delete).toHaveBeenCalledTimes(3);
        ["file1.mp3", "file2.mp3", "bad.mp3"].forEach((file) => {
            expect(deleter.delete).toHaveBeenCalledWith(
                `/fake/diaryDir/${file}`
            );
        });

        // Verify event log entries added correctly for each asset
        expect(storage.addEntry).toHaveBeenCalledTimes(3);
        const expectedEvent = {
            id: expect.anything(),
            date: expect.any(Date),
            original: "diary [when 0 hours ago] [audiorecording]",
            input: "diary [when 0 hours ago] [audiorecording]",
            modifiers: { when: "0 hours ago", audiorecording: "" },
            type: "diary",
            description: "",
            creator: expect.objectContaining({
                name: "Volodyslav",
                version: "0.1.0",
            }),
        };

        // The addEntry method is called for each of the three assets
        for (let i = 1; i <= 3; i++) {
            expect(storage.addEntry).toHaveBeenNthCalledWith(
                i,
                expectedEvent,
                expect.any(Array)
            );
        }
    });
});
