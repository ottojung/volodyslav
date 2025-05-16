// Reimplemented tests for processDiaryAudios using real capabilities and git-backed event log storage
const path = require("path");
const fs = require("fs/promises");
const temporary = require("./temporary");
const makeTestRepository = require("./make_test_repository");
const { processDiaryAudios } = require("../src/diary");
const gitstore = require("../src/gitstore");
const { readObjects } = require("../src/json_stream_file");
const { formatFileTimestamp } = require("../src/format_time_stamp");
const logger = require("../src/logger");

// Mock environment to isolate test directories
jest.mock("../src/environment", () => {
    const temporary = require("./temporary");
    const path = require("path");
    return {
        diaryAudiosDirectory: jest.fn().mockImplementation(() => {
            const dir = temporary.input();
            return path.join(dir, "diary");
        }),
        eventLogAssetsDirectory: jest.fn().mockImplementation(() => {
            const dir = temporary.output();
            return path.join(dir, "assets");
        }),
        eventLogDirectory: jest.fn().mockImplementation(() => {
            const dir = temporary.output();
            return path.join(dir, "eventlog");
        }),
        resultsDirectory: jest.fn().mockImplementation(() => {
            const dir = temporary.output();
            return path.join(dir, "results");
        }),
        logLevel: jest.fn().mockReturnValue("debug"),
        logFile: jest.fn().mockImplementation(() => {
            const dir = temporary.output();
            return path.join(dir, "log.txt");
        }),
    };
});

beforeEach(temporary.beforeEach);
afterEach(temporary.afterEach);

// Helper to create inspectable capability wrappers around real implementations
function makeMockCapabilities() {
    const realDeleter = require("../src/filesystem/deleter").make();
    const realCopier = require("../src/filesystem/copier").make();
    const realScanner = require("../src/filesystem/dirscanner").make();
    const realCreator = require("../src/filesystem/creator").make();
    const realAppender = require("../src/filesystem/appender").make();
    const realWriter = require("../src/filesystem/writer").make();

    return {
        deleter: {
            deleteFile: jest.fn((p) => realDeleter.deleteFile(p)),
            deleteDirectory: jest.fn((p) => realDeleter.deleteDirectory(p)),
        },
        copier: {
            copyFile: jest.fn((file, dest) => realCopier.copyFile(file, dest)),
        },
        scanner: {
            scanDirectory: jest.fn((dir) => realScanner.scanDirectory(dir)),
        },
        creator: {
            createDirectory: jest.fn((dir) => realCreator.createDirectory(dir)),
            createTemporaryDirectory: jest.fn(() =>
                realCreator.createTemporaryDirectory()
            ),
        },
        appender: {
            appendFile: jest.fn((file, content) =>
                realAppender.appendFile(file, content)
            ),
        },
        writer: {
            writeFile: jest.fn((file, content) =>
                realWriter.writeFile(file, content)
            ),
        },
        seed: { generate: jest.fn(() => 42) },
        git: require("../src/executables").git,
    };
}

describe("processDiaryAudios", () => {
    beforeEach(async () => {
        await logger.setup();
    });

    it("processes all diary audios successfully", async () => {
        await makeTestRepository();
        const capabilities = makeMockCapabilities();

        // Prepare diary directory with audio files
        const diaryDir = require("../src/environment").diaryAudiosDirectory();
        await fs.mkdir(diaryDir, { recursive: true });
        const filenames = [
            "20250511T000000Z.file1.mp3",
            "20250511T000001Z.file2.mp3",
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
        await gitstore.transaction(
            capabilities,
            require("../src/environment").eventLogDirectory(),
            async (store) => {
                const workTree = await store.getWorkTree();
                const dataPath = path.join(workTree, "data.json");
                const objects = await readObjects(dataPath);
                expect(objects).toHaveLength(filenames.length);
                objects.forEach((obj, i) => {
                    expect(obj).toEqual({
                        id: obj.id,
                        date: formatFileTimestamp(filenames[i]).toISOString(),
                        original: "diary [when 0 hours ago] [audiorecording]",
                        input: "diary [when 0 hours ago] [audiorecording]",
                        modifiers: { when: "0 hours ago", audiorecording: "" },
                        type: "diary",
                        description: "",
                        creator: expect.any(Object),
                    });
                });
            }
        );

        // Assets copied into correct structure
        const assetsBase =
            require("../src/environment").eventLogAssetsDirectory();
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
        await makeTestRepository();
        const capabilities = makeMockCapabilities();

        // Prepare diary directory
        const diaryDir = require("../src/environment").diaryAudiosDirectory();
        await fs.mkdir(diaryDir, { recursive: true });
        const valid = "20250511T000000Z.good.mp3";
        const invalid = "bad.mp3";
        await fs.writeFile(path.join(diaryDir, valid), "ok");
        await fs.writeFile(path.join(diaryDir, invalid), "fail");

        // Execute
        await processDiaryAudios(capabilities);

        // Only invalid remains
        const remaining = await fs.readdir(diaryDir);
        expect(remaining).toEqual([invalid]);

        // Only one entry in log
        await gitstore.transaction(
            capabilities,
            require("../src/environment").eventLogDirectory(),
            async (store) => {
                const workTree = await store.getWorkTree();
                const objects = await readObjects(
                    path.join(workTree, "data.json")
                );
                expect(objects).toHaveLength(1);
            }
        );
    });

    it("continues processing when event log transaction fails for an asset", async () => {
        await makeTestRepository();
        const capabilities = makeMockCapabilities();

        async function countLogEntries() {
            let length;
            await gitstore.transaction(
                capabilities,
                require("../src/environment").eventLogDirectory(),
                async (store) => {
                    const workTree = await store.getWorkTree();
                    const objects = await readObjects(
                        path.join(workTree, "data.json")
                    );
                    length = objects.length;
                }
            );
            return length;
        }

        // Override copier to throw for specific file
        const diaryDir = require("../src/environment").diaryAudiosDirectory();
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

        // Execute
        await processDiaryAudios(capabilities);

        // Only invalid remains
        const remaining = await fs.readdir(diaryDir);
        expect(remaining).toEqual([path.basename(badPath)]);

        // Only good file deleted.
        expect(capabilities.deleter.deleteFile).toHaveBeenCalledWith(goodPath);

        // One entry in log
        expect(await countLogEntries()).toBe(1);
    });
});
