const path = require("path");
const { transaction } = require("../src/event_log_storage");
const fsp = require("fs/promises");
const gitstore = require("../src/gitstore");
const { readObjects } = require("../src/json_stream_file");
const temporary = require("./temporary");
const makeTestRepository = require("./make_test_repository");
const event = require("../src/event/structure");
const { targetPath } = require("../src/event/asset");
const logger = require("../src/logger");

beforeEach(temporary.beforeEach);
afterEach(temporary.afterEach);

// Mock environment exports to avoid real env dependencies
jest.mock("../src/environment", () => {
    const temporary = require("./temporary");
    const path = require("path");
    return {
        logLevel: jest.fn().mockReturnValue("debug"),
        logFile: jest.fn().mockImplementation(() => {
            return path.join(temporary.output(), "log.txt");
        }),
        eventLogAssetsDirectory: jest.fn().mockImplementation(() => {
            const dir = temporary.output();
            return path.join(dir, "event_log_assets");
        }),
        eventLogDirectory: jest.fn().mockImplementation(() => {
            const dir = temporary.output();
            return path.join(dir, "event_log");
        }),
    };
});

describe("event_log_storage", () => {
    // No stubbing: use real gitstore.transaction with makeTestRepository per test

    test("transaction allows adding and storing event entries", async () => {
        await logger.setup();
        const deleter = { delete: jest.fn() };
        const { gitDir } = await makeTestRepository();

        const testEvent = {
            id: { identifier: "test123" },
            date: new Date("2025-05-12"),
            original: "test input",
            input: "processed test input",
            modifiers: { test: "modifier" },
            type: "test_event",
            description: "Test event description",
        };

        await transaction(deleter, async (eventLogStorage) => {
            eventLogStorage.addEntry(testEvent, []);
        });

        // Verify the stored event using gitstore transaction
        await gitstore.transaction(gitDir, async (store) => {
            const workTree = await store.getWorkTree();
            const dataPath = path.join(workTree, "data.json");
            const objects = await readObjects(dataPath);
            expect(objects).toHaveLength(1);
            expect(objects[0]).toEqual(event.serialize(testEvent));
        });
    });

    test("transaction allows adding and storing multiple event entries", async () => {
        await logger.setup();
        const deleter = { delete: jest.fn() };
        const { gitDir } = await makeTestRepository();

        const event1 = {
            id: { identifier: "event1" },
            date: new Date("2025-05-12"),
            original: "first input",
            input: "processed first input",
            modifiers: { foo: "bar" },
            type: "first_event",
            description: "First event description",
        };
        const event2 = {
            id: { identifier: "event2" },
            date: new Date("2025-05-12"),
            original: "second input",
            input: "processed second input",
            modifiers: { baz: "qux" },
            type: "second_event",
            description: "Second event description",
        };

        await transaction(deleter, async (eventLogStorage) => {
            eventLogStorage.addEntry(event1, []);
            eventLogStorage.addEntry(event2, []);
        });

        await gitstore.transaction(gitDir, async (store) => {
            const workTree = await store.getWorkTree();
            const dataPath = path.join(workTree, "data.json");
            const objects = await readObjects(dataPath);
            expect(objects).toHaveLength(2);
            expect(objects[0]).toEqual(event.serialize(event1));
            expect(objects[1]).toEqual(event.serialize(event2));
        });
    });

    test("transaction with no entries throws an error", async () => {
        await logger.setup();
        const deleter = { delete: jest.fn() };
        await makeTestRepository();
        // Expect the transaction to fail due to no staged changes to commit
        await expect(
            transaction(deleter, async () => {
                // no entries added
            })
        ).rejects.toThrow();
    });

    test("transaction copies asset files into repository", async () => {
        await logger.setup();
        const deleter = { delete: jest.fn() };
        await makeTestRepository();
        const testEvent = {
            id: { identifier: "assetEvent" },
            date: new Date("2025-05-13"),
        };

        // Create a temporary asset file.
        const inputDir = path.join(temporary.input(), "inputs");
        const assetPath = path.join(inputDir, "asset.txt");
        await fsp.mkdir(inputDir, { recursive: true });
        await fsp.writeFile(assetPath, "test content");

        await transaction(deleter, async (storage) =>
            storage.addEntry(testEvent, [
                { event: testEvent, filepath: assetPath },
            ])
        );

        const asset = {
            event: testEvent,
            filepath: assetPath,
        };
        const target = targetPath(asset);

        const targetDir = path.dirname(target);
        const dirExists = await fsp
            .stat(targetDir)
            .then(() => true)
            .catch(() => false);
        expect(dirExists).toBe(true);

        const fileExists = await fsp
            .stat(target)
            .then(() => true)
            .catch(() => false);
        expect(fileExists).toBe(true);
    });

    test("transaction cleanup calls unlink for each asset on failure", async () => {
        await logger.setup();
        const deleter = { delete: jest.fn() };
        await makeTestRepository();
        const testEvent = { id: { identifier: "cleanupEvent" } };
        const assetPath = "/some/failure.txt";
        await expect(
            transaction(deleter, async (storage) => {
                storage.addEntry(testEvent, [
                    { identifier: testEvent.id, filepath: assetPath },
                ]);
                throw new Error("forced failure");
            })
        ).rejects.toThrow("forced failure");
        expect(deleter.delete).toHaveBeenCalledWith(assetPath);
    });

    test("transaction creates parent directories before copying assets", async () => {
        await logger.setup();
        const deleter = { delete: jest.fn() };
        await makeTestRepository();

        const testEvent = {
            id: { identifier: "assetEventWithDirs" },
            date: new Date("2025-05-13"),
        };

        // Create a temporary asset file.
        const inputDir = path.join(temporary.input(), "inputs");
        const assetPath = path.join(inputDir, "asset.txt");
        await fsp.mkdir(inputDir, { recursive: true });
        await fsp.writeFile(assetPath, "test content");

        await transaction(deleter, async (storage) =>
            storage.addEntry(testEvent, [
                { event: testEvent, filepath: assetPath },
            ])
        );

        expect(deleter.delete).not.toHaveBeenCalled();

        const asset = {
            event: testEvent,
            filepath: assetPath,
        };
        const target = targetPath(asset);

        const targetDir = path.dirname(target);
        const dirExists = await fsp
            .stat(targetDir)
            .then(() => true)
            .catch(() => false);
        expect(dirExists).toBe(true);

        const fileExists = await fsp
            .stat(target)
            .then(() => true)
            .catch(() => false);
        expect(fileExists).toBe(true);
    });

    test("transaction handles mix of successful and failed asset additions", async () => {
        await logger.setup();
        const deleter = { delete: jest.fn() };
        const { gitDir } = await makeTestRepository();

        const testEvent = {
            id: { identifier: "mixedAssetsEvent" },
            date: new Date("2025-05-13"),
            type: "test_event",
            description: "Mixed assets test event",
        };

        // Create real files that will succeed
        const inputDir = path.join(temporary.input(), "valid_assets");
        await fsp.mkdir(inputDir, { recursive: true });
        
        const validPaths = [];
        const invalidPaths = [];
        
        // Create 3 valid files
        for (let i = 1; i <= 3; i++) {
            const validPath = path.join(inputDir, `valid_asset_${i}.txt`);
            await fsp.writeFile(validPath, `valid content ${i}`);
            validPaths.push(validPath);
        }
        
        // Create 3 invalid paths that don't exist
        for (let i = 1; i <= 3; i++) {
            const invalidPath = path.join(temporary.input(), `nonexistent_dir_${i}`, `invalid_asset_${i}.txt`);
            invalidPaths.push(invalidPath);
        }
        
        // Mix valid and invalid assets
        const allAssets = [
            ...validPaths.map(filepath => ({ event: testEvent, filepath })),
            ...invalidPaths.map(filepath => ({ event: testEvent, filepath }))
        ];
        
        // Execute the transaction with mixed assets
        await expect(
            transaction(deleter, async (storage) => {
                storage.addEntry(testEvent, allAssets);
            })
        ).rejects.toThrow(); // Should throw due to invalid paths
        
        // Check that the deleter was called for all valid paths 
        // (as those would have been successfully copied before the error)
        validPaths.forEach(validPath => {
            expect(deleter.delete).toHaveBeenCalledWith(validPath);
        });
        
        // Verify that event was not stored due to transaction failure
        await gitstore.transaction(gitDir, async (store) => {
            const workTree = await store.getWorkTree();
            const dataPath = path.join(workTree, "data.json");
            
            // If data.json exists, confirm event wasn't stored
            try {
                const objects = await readObjects(dataPath);
                expect(objects).not.toContainEqual(event.serialize(testEvent));
            } catch (err) {
                // If the file doesn't exist, that's fine too - it means no event was stored
                expect(err.code).toBe('ENOENT');
            }
        });
    });
});
