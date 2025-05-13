// backend/tests/diary.test.js

// This test verifies that `processDiaryAudios` correctly handles transcription
// results by copying successful audio files, removing originals, logging failures,
// and recording events in the event log. It uses mocks to simulate file operations,
// transcription outputs, and the event-log API.
const path = require("path");

jest.mock("fs/promises", () => ({
    // Mock file operations to spy on readdir, copyFile and unlink calls
    readdir: jest.fn(),
    copyFile: jest.fn(),
    unlink: jest.fn(),
    access: jest.fn(),
    mkdir: jest.fn(),
}));

// Mock environment functions to provide fixed diary and assets directories
jest.mock("../src/environment", () => ({
    diaryAudiosDirectory: jest.fn(),
    eventLogAssetsDirectory: jest.fn(),
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
}));

const { processDiaryAudios } = require("../src/diary");
const { readdir, copyFile } = require("fs/promises");
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
        // copyFile succeeds for good files, fails for bad.mp3
        copyFile.mockImplementation((src, _dest) => {
            if (src.endsWith("bad.mp3")) return Promise.reject(new Error("error occurred"));
            return Promise.resolve();
        });
        // Use the mock transaction to invoke callback with our fake storage
        transaction.mockImplementation(async (cb) => {
            await cb(storage);
        });
    });

    it("should process diary audios correctly", async () => {
        // Mock the file deleter and random generator
        const deleter = { delete: jest.fn() };
        const rng = random.default_generator(42);
        // Invoke the processing function under test
        await processDiaryAudios(deleter, rng);

        // Verify that copy failures are logged with logError
        expect(logError).toHaveBeenCalledWith(
            {
                file: "bad.mp3",
                error: "error occurred",
                directory: "/fake/diaryDir",
            },
            expect.stringContaining("Diary audio copy failed")
        );

        // Verify successful files are copied to the correct asset directories
        const dateStr = new Date("2025-05-12").toISOString();
        expect(copyFile).toHaveBeenCalledTimes(3);
        expect(copyFile).toHaveBeenCalledWith(
            "/fake/diaryDir/file1.mp3",
            path.join("/fake/assetsDir", dateStr, "file1.mp3")
        );
        expect(copyFile).toHaveBeenCalledWith(
            "/fake/diaryDir/file2.mp3",
            path.join("/fake/assetsDir", dateStr, "file2.mp3")
        );

        // Verify original files are removed after copying
        expect(deleter.delete).toHaveBeenCalledTimes(2);
        expect(deleter.delete).toHaveBeenCalledWith("/fake/diaryDir/file1.mp3");
        expect(deleter.delete).toHaveBeenCalledWith("/fake/diaryDir/file2.mp3");

        // Verify event log transaction was called and entries added correctly
        expect(transaction).toHaveBeenCalled();
        expect(storage.addEntry).toHaveBeenCalledTimes(2);
        const expectedEvent = {
            id: expect.anything(),
            date: new Date(dateStr),
            original: "diary [when 0 hours ago]",
            input: "diary [when 0 hours ago]",
            modifiers: { when: "0 hours ago" },
            type: "diary",
            description: "",
        };
        // The addEntry method is called with the event object and the list of entries
        expect(storage.addEntry).toHaveBeenNthCalledWith(
            1,
            expectedEvent,
            expect.any(Array)
        );
        expect(storage.addEntry).toHaveBeenNthCalledWith(
            2,
            expectedEvent,
            expect.any(Array)
        );
    });
});
