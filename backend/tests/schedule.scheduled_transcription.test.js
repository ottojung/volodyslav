/**
 * Tests for scheduled transcription functionality.
 * 
 * This module tests the implementation of Issue #7: "Implement scheduled transcription"
 */

const path = require("path");
const fs = require("fs").promises;
const {
    executeScheduledTranscription,
    isScheduledTranscriptionError,
    ScheduledTranscriptionError,
    isAudioFile,
    getTranscriptionPath,
    transcriptionExists,
    findAudioFilesNeedingTranscription,
    transcribeAudioFile,
} = require("../src/schedule/scheduled_transcription");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger, stubEnvironment } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    
    // Ensure all file operations are properly mocked
    capabilities.reader.createReadStream.mockReturnValue({});
    capabilities.checker.instantiate.mockResolvedValue({ path: "/test/file.mp3" });
    capabilities.creator.createFile.mockResolvedValue({ path: "/test/output.json" });
    capabilities.writer.writeFile.mockResolvedValue();
    
    return capabilities;
}

describe("Scheduled Transcription", () => {
    describe("ScheduledTranscriptionError", () => {
        test("is a constructor function", () => {
            expect(typeof ScheduledTranscriptionError).toBe("function");
        });

        test("creates error instance with correct properties", () => {
            const cause = new Error("original error");
            const error = new ScheduledTranscriptionError("test message", cause);
            expect(error.name).toBe("ScheduledTranscriptionError");
            expect(error.message).toBe("test message");
            expect(error.cause).toBe(cause);
        });

        test("type guard function exists and works correctly", () => {
            expect(typeof isScheduledTranscriptionError).toBe("function");
            
            const error = new ScheduledTranscriptionError("test", null);
            expect(isScheduledTranscriptionError(error)).toBe(true);
            
            const regularError = new Error("regular");
            expect(isScheduledTranscriptionError(regularError)).toBe(false);
            
            expect(isScheduledTranscriptionError({})).toBe(false);
            expect(isScheduledTranscriptionError(null)).toBe(false);
        });
    });

    describe("isAudioFile", () => {
        test("returns true for audio file extensions", () => {
            expect(isAudioFile("test.mp3")).toBe(true);
            expect(isAudioFile("test.wav")).toBe(true);
            expect(isAudioFile("test.m4a")).toBe(true);
            expect(isAudioFile("test.mp4")).toBe(true);
            expect(isAudioFile("test.webm")).toBe(true);
            expect(isAudioFile("/path/to/file.MP3")).toBe(true); // case insensitive
        });

        test("returns false for non-audio files", () => {
            expect(isAudioFile("test.txt")).toBe(false);
            expect(isAudioFile("test.json")).toBe(false);
            expect(isAudioFile("test.jpg")).toBe(false);
            expect(isAudioFile("test")).toBe(false);
            expect(isAudioFile("")).toBe(false);
        });
    });

    describe("getTranscriptionPath", () => {
        test("appends .transcription.json to audio file path", () => {
            expect(getTranscriptionPath("/path/to/audio.mp3"))
                .toBe("/path/to/audio.mp3.transcription.json");
            expect(getTranscriptionPath("simple.wav"))
                .toBe("simple.wav.transcription.json");
        });
    });

    describe("transcriptionExists", () => {
        test("returns true when transcription file exists", async () => {
            const capabilities = getTestCapabilities();
            capabilities.checker.instantiate.mockResolvedValue({});
            
            const result = await transcriptionExists(capabilities, "/path/to/audio.mp3");
            expect(result).toBe(true);
            expect(capabilities.checker.instantiate).toHaveBeenCalledWith(
                "/path/to/audio.mp3.transcription.json"
            );
        });

        test("returns false when transcription file does not exist", async () => {
            const capabilities = getTestCapabilities();
            capabilities.checker.instantiate.mockRejectedValue(new Error("File not found"));
            
            const result = await transcriptionExists(capabilities, "/path/to/audio.mp3");
            expect(result).toBe(false);
        });
    });

    describe("findAudioFilesNeedingTranscription", () => {
        test("finds audio files without transcriptions", async () => {
            const capabilities = getTestCapabilities();
            
            // Mock directory structure
            const mockFiles = [
                { path: "/assets/audio1.mp3" },
                { path: "/assets/audio2.wav" },
                { path: "/assets/text.txt" },
                { path: "/assets/subdir" },
            ];
            
            capabilities.scanner.scanDirectory.mockResolvedValue(mockFiles);
            
            // Mock fs.stat calls
            const mockFs = require("fs").promises;
            jest.doMock("fs", () => ({
                promises: {
                    stat: jest.fn(),
                },
            }));
            
            // Create new mock that we can control
            const statMock = jest.fn();
            statMock
                .mockResolvedValueOnce({ isDirectory: () => false }) // audio1.mp3
                .mockResolvedValueOnce({ isDirectory: () => false }) // audio2.wav
                .mockResolvedValueOnce({ isDirectory: () => false }) // text.txt
                .mockResolvedValueOnce({ isDirectory: () => true });  // subdir
            
            // Override the stat function in our module
            const fs = require("fs").promises;
            fs.stat = statMock;
            
            // Mock transcription existence checks
            capabilities.checker.instantiate
                .mockRejectedValueOnce(new Error("Not found")) // audio1.mp3 needs transcription
                .mockResolvedValueOnce({});                    // audio2.wav has transcription
            
            // Mock recursive call for subdirectory (return empty array)
            const originalFind = findAudioFilesNeedingTranscription;
            const findSpy = jest.spyOn(require("../src/schedule/scheduled_transcription"), "findAudioFilesNeedingTranscription");
            findSpy.mockImplementationOnce(originalFind); // First call (our call)
            findSpy.mockResolvedValueOnce([]); // Recursive call for subdir
            
            const result = await findAudioFilesNeedingTranscription(capabilities, "/assets");
            
            expect(result).toEqual(["/assets/audio1.mp3"]);
            expect(capabilities.scanner.scanDirectory).toHaveBeenCalledWith("/assets");
            
            findSpy.mockRestore();
        });

        test("handles directory scan errors gracefully", async () => {
            const capabilities = getTestCapabilities();
            capabilities.scanner.scanDirectory.mockRejectedValue(new Error("Permission denied"));
            
            const result = await findAudioFilesNeedingTranscription(capabilities, "/inaccessible");
            
            expect(result).toEqual([]);
            expect(capabilities.logger.logWarning).toHaveBeenCalledWith(
                expect.objectContaining({
                    error: "Permission denied",
                    dirPath: "/inaccessible"
                }),
                expect.stringContaining("Failed to scan directory")
            );
        });
    });

    describe("transcribeAudioFile", () => {
        test("successfully transcribes an audio file", async () => {
            const capabilities = getTestCapabilities();
            const mockAudioFile = { path: "/path/to/audio.mp3" };
            
            capabilities.checker.instantiate.mockResolvedValue(mockAudioFile);
            
            // Mock the AI transcription
            capabilities.aiTranscription.transcribeStream.mockResolvedValue("transcribed text");
            capabilities.aiTranscription.getTranscriberInfo.mockReturnValue({ 
                name: "test-model", 
                creator: "test-creator" 
            });
            
            await transcribeAudioFile(capabilities, "/path/to/audio.mp3");
            
            expect(capabilities.checker.instantiate).toHaveBeenCalledWith("/path/to/audio.mp3");
            expect(capabilities.creator.createFile).toHaveBeenCalledWith(
                "/path/to/audio.mp3.transcription.json"
            );
            expect(capabilities.logger.logInfo).toHaveBeenCalledTimes(2); // start and success messages
        });

        test("handles transcription failures", async () => {
            const capabilities = getTestCapabilities();
            const mockAudioFile = { path: "/path/to/audio.mp3" };
            
            capabilities.checker.instantiate.mockResolvedValue(mockAudioFile);
            capabilities.aiTranscription.transcribeStream.mockRejectedValue(new Error("Transcription failed"));
            
            await expect(transcribeAudioFile(capabilities, "/path/to/audio.mp3"))
                .rejects.toThrow(ScheduledTranscriptionError);
            
            expect(capabilities.logger.logError).toHaveBeenCalledWith(
                expect.objectContaining({
                    error: expect.stringContaining("Transcription failed"),
                    audioFilePath: "/path/to/audio.mp3"
                }),
                expect.stringContaining("Failed to transcribe")
            );
        });
    });

    describe("executeScheduledTranscription", () => {
        test("completes successfully when no audio files need transcription", async () => {
            const capabilities = getTestCapabilities();
            capabilities.environment.eventLogAssetsDirectory.mockReturnValue("/assets");
            capabilities.scanner.scanDirectory.mockResolvedValue([]);
            
            await executeScheduledTranscription(capabilities);
            
            expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                {},
                "No audio files found that need transcription"
            );
        });

        test("transcribes audio files successfully", async () => {
            const capabilities = getTestCapabilities();
            capabilities.environment.eventLogAssetsDirectory.mockReturnValue("/assets");
            
            // Mock finding audio files
            const audioFiles = [
                { path: "/assets/2025-01/01/event1/audio1.mp3" },
                { path: "/assets/2025-01/01/event2/audio2.wav" },
            ];
            capabilities.scanner.scanDirectory.mockResolvedValue(audioFiles);
            
            // Mock fs.stat to return file stats
            const fs = require("fs").promises;
            const statMock = jest.fn().mockResolvedValue({ isDirectory: () => false });
            fs.stat = statMock;
            
            // Mock transcription checks - both files need transcription
            capabilities.checker.instantiate
                .mockRejectedValueOnce(new Error("Not found")) // audio1.mp3 needs transcription
                .mockRejectedValueOnce(new Error("Not found")) // audio2.wav needs transcription  
                .mockResolvedValue({ path: "/test/file" });     // For transcribeAudioFile calls
            
            // Mock AI transcription
            capabilities.aiTranscription.transcribeStream.mockResolvedValue("transcribed text");
            capabilities.aiTranscription.getTranscriberInfo.mockReturnValue({ 
                name: "test-model", 
                creator: "test-creator" 
            });
            
            await executeScheduledTranscription(capabilities);
            
            expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                expect.objectContaining({
                    totalFiles: 2,
                    successCount: 2,
                    failureCount: 0
                }),
                expect.stringContaining("Successfully transcribed 2 files")
            );
        });

        test("handles partial failures gracefully", async () => {
            const capabilities = getTestCapabilities();
            capabilities.environment.eventLogAssetsDirectory.mockReturnValue("/assets");
            
            // Mock finding audio files  
            const audioFiles = [
                { path: "/assets/audio1.mp3" },
                { path: "/assets/audio2.wav" },
            ];
            capabilities.scanner.scanDirectory.mockResolvedValue(audioFiles);
            
            // Mock fs.stat
            const fs = require("fs").promises;
            const statMock = jest.fn().mockResolvedValue({ isDirectory: () => false });
            fs.stat = statMock;
            
            // Mock transcription checks - both files need transcription
            capabilities.checker.instantiate
                .mockRejectedValueOnce(new Error("Not found")) // audio1.mp3 needs transcription
                .mockRejectedValueOnce(new Error("Not found")) // audio2.wav needs transcription
                .mockResolvedValueOnce({ path: "/test/file1" })  // For first transcribeAudioFile
                .mockResolvedValueOnce({ path: "/test/file2" }); // For second transcribeAudioFile
            
            // Mock AI transcription - first succeeds, second fails
            capabilities.aiTranscription.transcribeStream
                .mockResolvedValueOnce("transcribed text")
                .mockRejectedValueOnce(new Error("Transcription failed"));
            capabilities.aiTranscription.getTranscriberInfo.mockReturnValue({ 
                name: "test-model", 
                creator: "test-creator" 
            });
            
            await executeScheduledTranscription(capabilities);
            
            expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                expect.objectContaining({
                    totalFiles: 2,
                    successCount: 1,
                    failureCount: 1
                }),
                expect.stringContaining("Successfully transcribed 1 files, 1 failures")
            );
        });

        test("handles directory access errors gracefully", async () => {
            const capabilities = getTestCapabilities();
            capabilities.environment.eventLogAssetsDirectory.mockReturnValue("/assets");
            capabilities.scanner.scanDirectory.mockRejectedValue(new Error("Directory access failed"));
            
            // This should complete successfully but log a warning and find no files
            await executeScheduledTranscription(capabilities);
            
            expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                {},
                "No audio files found that need transcription"
            );
        });
    });
});