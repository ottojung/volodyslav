// Reimplemented tests for processDiaryAudios using real capabilities and git-backed event log storage
const path = require("path");
const fs = require("fs/promises");
const { processDiaryAudios } = require("../src/diary");
const gitstore = require("../src/gitstore");
const { readObjects } = require("../src/json_stream_file");
const checker = require("../src/filesystem/checker");
const { formatFileTimestamp } = require("../src/format_time_stamp");
const dateFormatter = require("../src/event/date");
const {
    stubEnvironment,
    stubLogger,
    stubEventLogRepository,
} = require("./stubs");
const { getMockedRootCapabilities } = require("./spies");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);

    // Mock isFileStable to return true by default for existing tests
    capabilities.checker.isFileStable = jest.fn().mockResolvedValue(true);

    return capabilities;
}

async function countLogEntries(capabilities) {
    let length;
    await gitstore.transaction(capabilities, async (store) => {
        const workTree = await store.getWorkTree();
        const dataFile = await checker.make().instanciate(path.join(workTree, "data.json"));
        const objects = await readObjects(
            capabilities,
            dataFile
        );
        length = objects.length;
    });
    return length;
}

describe("processDiaryAudios", () => {
    it("processes all diary audios successfully", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

        // Prepare diary directory with audio files
        const diaryDir = capabilities.environment.diaryAudiosDirectory();
        await fs.mkdir(diaryDir, { recursive: true });
        const filenames = [
            "20250511T000000Z.file1.mp3",
            "20250512T000001Z.file2.mp3",
        ];
        for (const name of filenames) {
            await fs.writeFile(path.join(diaryDir, name), "content");
        }

        // Execute
        await processDiaryAudios(capabilities);

        // Originals removed
        const remaining = await fs.readdir(diaryDir);
        expect(remaining).toHaveLength(0);
        expect(capabilities.deleter.deleteFile).toHaveBeenCalledTimes(
            filenames.length
        );

        // Event log entries committed
        await gitstore.transaction(capabilities, async (store) => {
            const workTree = await store.getWorkTree();
            const dataPath = path.join(workTree, "data.json");
            const dataFile = await checker.make().instanciate(dataPath);
            const objects = await readObjects(capabilities, dataFile);
            expect(objects).toHaveLength(filenames.length);
            objects.forEach((obj, i) => {
                const date = formatFileTimestamp(filenames[i]);
                expect(obj).toEqual({
                    id: obj.id,
                    date: dateFormatter.format(date),
                    original: "diary [when 0 hours ago] [audiorecording]",
                    input: "diary [when 0 hours ago] [audiorecording]",
                    modifiers: { when: "0 hours ago", audiorecording: "" },
                    type: "diary",
                    description: "",
                    creator: expect.any(Object),
                });
            });
        });

        // Assets copied into correct structure
        const assetsBase = capabilities.environment.eventLogAssetsDirectory();
        for (const name of filenames) {
            const date = formatFileTimestamp(name);
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, "0");
            const day = String(date.getDate()).padStart(2, "0");
            // Expect one id directory under the date folder
            const idDirs = await fs.readdir(
                path.join(assetsBase, `${year}-${month}`, day)
            );
            expect(idDirs).toHaveLength(1);
            const files = await fs.readdir(
                path.join(assetsBase, `${year}-${month}`, day, idDirs[0])
            );
            expect(files).toContain(path.basename(name));
        }
    });

    it("skips files with invalid timestamp names and logs errors", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

        // Prepare diary directory
        const diaryDir = capabilities.environment.diaryAudiosDirectory();
        await fs.mkdir(diaryDir, { recursive: true });
        const valid = "20250511T000000Z.good.mp3";
        const invalid = "bad.mp3";
        await fs.writeFile(path.join(diaryDir, valid), "ok");
        await fs.writeFile(path.join(diaryDir, invalid), "fail");

        // Empty log before execution.
        expect(await countLogEntries(capabilities)).toBe(0);

        // Execute
        await processDiaryAudios(capabilities);

        // Only invalid remains
        const remaining = await fs.readdir(diaryDir);
        expect(remaining).toEqual([invalid]);

        // Only one entry in log
        expect(await countLogEntries(capabilities)).toBe(1);
    });

    it("continues processing when event log transaction fails for an asset", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

        // Override copier to throw for specific file
        const diaryDir = capabilities.environment.diaryAudiosDirectory();
        const goodPath = path.join(diaryDir, "20250511T000001Z.good.mp3");
        const badPath = path.join(diaryDir, "20250511T000000Z.bad.mp3");
        await fs.mkdir(diaryDir, { recursive: true });
        await fs.writeFile(goodPath, "content");
        await fs.writeFile(badPath, "content");

        const originalCopy = capabilities.copier.copyFile;
        capabilities.copier.copyFile = jest.fn(async (file, dest) => {
            if (file.path.endsWith("bad.mp3")) {
                throw new Error("copy failed");
            }
            return originalCopy(file, dest);
        });

        // Empty log before execution.
        expect(await countLogEntries(capabilities)).toBe(0);

        // Execute
        await processDiaryAudios(capabilities);

        // Only invalid remains
        const remaining = await fs.readdir(diaryDir);
        expect(remaining).toEqual([path.basename(badPath)]);

        // Only good file deleted.
        expect(capabilities.deleter.deleteFile).toHaveBeenCalledWith(goodPath);

        // One entry in log
        expect(await countLogEntries(capabilities)).toBe(1);
    });

    it("skips unstable files that are still being recorded", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

        // Prepare diary directory with audio files
        const diaryDir = capabilities.environment.diaryAudiosDirectory();
        await fs.mkdir(diaryDir, { recursive: true });

        const stableFile = "20250511T000000Z.stable.mp3";
        const unstableFile = "20250511T000001Z.unstable.mp3";

        await fs.writeFile(path.join(diaryDir, stableFile), "stable content");
        await fs.writeFile(
            path.join(diaryDir, unstableFile),
            "unstable content"
        );

        // Mock the checker to return false for unstable file
        capabilities.checker.isFileStable = jest.fn(async (file) => {
            return !file.path.includes("unstable");
        });

        // Execute
        await processDiaryAudios(capabilities);

        // Only unstable file should remain (stable file processed and deleted)
        const remaining = await fs.readdir(diaryDir);
        expect(remaining).toEqual([unstableFile]);

        // Verify stability check was called for both files
        expect(capabilities.checker.isFileStable).toHaveBeenCalledTimes(2);
        expect(capabilities.checker.isFileStable).toHaveBeenCalledWith(
            expect.objectContaining({
                path: path.join(diaryDir, stableFile),
            })
        );
        expect(capabilities.checker.isFileStable).toHaveBeenCalledWith(
            expect.objectContaining({
                path: path.join(diaryDir, unstableFile),
            })
        );

        // Only stable file should be deleted
        expect(capabilities.deleter.deleteFile).toHaveBeenCalledWith(
            path.join(diaryDir, stableFile)
        );
        expect(capabilities.deleter.deleteFile).not.toHaveBeenCalledWith(
            expect.objectContaining({
                path: path.join(diaryDir, unstableFile),
            })
        );

        // One entry in log (for stable file only)
        expect(await countLogEntries(capabilities)).toBe(1);
    });

    it("handles file stability check errors gracefully", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

        // Prepare diary directory with audio files
        const diaryDir = capabilities.environment.diaryAudiosDirectory();
        await fs.mkdir(diaryDir, { recursive: true });

        const goodFile = "20250511T000000Z.good.mp3";
        const errorFile = "20250511T000001Z.error.mp3";

        await fs.writeFile(path.join(diaryDir, goodFile), "good content");
        await fs.writeFile(path.join(diaryDir, errorFile), "error content");

        // Mock the checker to throw error for error file
        capabilities.checker.isFileStable = jest.fn(async (file) => {
            if (file.path.includes("error")) {
                throw new Error("Permission denied");
            }
            return true; // good file is stable
        });

        // Execute
        await processDiaryAudios(capabilities);

        // Error file should remain (not processed due to stability check error)
        const remaining = await fs.readdir(diaryDir);
        expect(remaining).toEqual([errorFile]);

        // Only good file should be deleted
        expect(capabilities.deleter.deleteFile).toHaveBeenCalledWith(
            path.join(diaryDir, goodFile)
        );
        expect(capabilities.deleter.deleteFile).not.toHaveBeenCalledWith(
            path.join(diaryDir, errorFile)
        );

        // Warning should be logged for error file
        expect(capabilities.logger.logWarning).toHaveBeenCalledWith(
            expect.objectContaining({
                file: path.join(diaryDir, errorFile),
                error: "Permission denied",
            }),
            expect.stringContaining("Failed to check file stability")
        );
    });
});
