const path = require("path");
const { transaction } = require("../src/event_log_storage");
const fsp = require("fs/promises");
const gitstore = require("../src/gitstore");
const { readObjects } = require("../src/json_stream_file");
const event = require("../src/event/structure");
const { targetPath } = require("../src/event/asset");
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
    return capabilities;
}

describe("event_log_storage", () => {
    // No stubbing: use real gitstore.transaction with stubEventLogRepository per test

    test("transaction allows adding and storing event entries", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

        const testEvent = {
            id: { identifier: "test123" },
            date: new Date("2025-05-12"),
            original: "test input",
            input: "processed test input",
            modifiers: { test: "modifier" },
            type: "test_event",
            description: "Test event description",
        };

        await transaction(capabilities, async (eventLogStorage) => {
            eventLogStorage.addEntry(testEvent, []);
        });

        // Verify the stored event using gitstore transaction
        await gitstore.transaction(capabilities, async (store) => {
            const workTree = await store.getWorkTree();
            const dataPath = path.join(workTree, "data.json");
            const objects = await readObjects(dataPath);
            expect(objects).toHaveLength(1);
            expect(objects[0]).toEqual(event.serialize(testEvent));
        });
    });

    test("transaction fails if git fails", async () => {
        const capabilities = getTestCapabilities();

        // Note: didn't use stubEventLogRepository here to avoid creating a real git repo.

        const testEvent = {
            id: { identifier: "test123" },
            date: new Date("2025-05-12"),
            original: "test input",
            input: "processed test input",
            modifiers: { test: "modifier" },
            type: "test_event",
            description: "Test event description",
        };

        await expect(
            transaction(capabilities, async (eventLogStorage) => {
                eventLogStorage.addEntry(testEvent, []);
            })
        ).rejects.toThrow();

        await expect(
            gitstore.transaction(capabilities, async (_store) => {})
        ).rejects.toThrow("does not exist");
    });

    test("transaction allows adding and storing multiple event entries", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

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

        await transaction(capabilities, async (eventLogStorage) => {
            eventLogStorage.addEntry(event1, []);
            eventLogStorage.addEntry(event2, []);
        });

        await gitstore.transaction(capabilities, async (store) => {
            const workTree = await store.getWorkTree();
            const dataPath = path.join(workTree, "data.json");
            const objects = await readObjects(dataPath);
            expect(objects).toHaveLength(2);
            expect(objects[0]).toEqual(event.serialize(event1));
            expect(objects[1]).toEqual(event.serialize(event2));
        });
    });

    test("transaction with no entries throws an error", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);
        // Expect the transaction to fail due to no staged changes to commit
        await expect(
            transaction(capabilities, async () => {
                // no entries added
            })
        ).rejects.toThrow();
    });

    test("transaction copies asset files into repository", async () => {
        const capabilities = getTestCapabilities(); // Ensure capabilities are correctly initialized
        await stubEventLogRepository(capabilities);
        const testEvent = {
            id: { identifier: "assetEvent" },
            date: new Date("2025-05-13"),
        };

        // Create a temporary asset file.
        const inputDir = await capabilities.creator.createTemporaryDirectory(
            capabilities
        );
        const assetPath = path.join(inputDir, "asset.txt");
        await fsp.mkdir(inputDir, { recursive: true });
        await fsp.writeFile(assetPath, "test content");
        const asset = {
            event: testEvent,
            file: { path: assetPath, __brand: "ExistingFile" },
        };

        await transaction(capabilities, async (storage) =>
            storage.addEntry(testEvent, [asset])
        );

        const target = targetPath(capabilities, asset);

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
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);
        const testEvent = {
            id: { identifier: "cleanupEvent" },
            date: new Date("2025-05-14"),
        };
        const assetPath = "/some/failure.txt";
        const asset = {
            event: testEvent,
            file: { path: assetPath, __brand: "ExistingFile" },
        };

        await expect(
            transaction(capabilities, async (storage) => {
                storage.addEntry(testEvent, [asset]);
                throw new Error("forced failure");
            })
        ).rejects.toThrow("forced failure");

        // Should delete the copied asset file at its target path
        const expectedTarget = targetPath(capabilities, asset);
        expect(capabilities.deleter.deleteFile).toHaveBeenCalledWith(
            expectedTarget
        );
    });

    test("transaction creates parent directories before copying assets", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

        const testEvent = {
            id: { identifier: "assetEventWithDirs" },
            date: new Date("2025-05-13"),
        };

        // Create a temporary asset file.
        const inputDir = await capabilities.creator.createTemporaryDirectory(
            capabilities
        );
        const assetPath = path.join(inputDir, "asset.txt");
        await fsp.mkdir(inputDir, { recursive: true });
        await fsp.writeFile(assetPath, "test content");
        const asset = {
            event: testEvent,
            file: { path: assetPath, __brand: "ExistingFile" },
        };

        await transaction(capabilities, async (storage) =>
            storage.addEntry(testEvent, [asset])
        );

        expect(capabilities.deleter.deleteFile).not.toHaveBeenCalled();

        const target = targetPath(capabilities, asset);

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
        const capabilities = getTestCapabilities(); // Ensure capabilities are correctly initialized
        await stubEventLogRepository(capabilities);

        const testEvent = {
            id: { identifier: "mixedAssetsEvent" },
            date: new Date("2025-05-13"),
            type: "test_event",
            description: "Mixed assets test event",
        };

        // Helper function to create test assets
        const createTestAssets = async () => {
            const inputDir =
                await capabilities.creator.createTemporaryDirectory(
                    capabilities
                );
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
                const invalidPath = path.join(
                    inputDir,
                    `nonexistent_dir_${i}`,
                    `invalid_asset_${i}.txt`
                );
                invalidPaths.push(invalidPath);
            }

            return {
                validPaths,
                invalidPaths,
                allAssets: [
                    ...validPaths.map((filepath) => ({
                        event: testEvent,
                        file: { path: filepath, __brand: "ExistingFile" },
                    })),
                    ...invalidPaths.map((filepath) => ({
                        event: testEvent,
                        file: { path: filepath, __brand: "ExistingFile" }, // Source file won't exist, copier mock will throw
                    })),
                ],
            };
        };

        // Create our test assets
        const { allAssets } = await createTestAssets(); // Removed validPaths from destructuring

        // Execute the transaction with mixed assets
        await expect(
            transaction(capabilities, async (storage) => {
                storage.addEntry(testEvent, allAssets);
            })
        ).rejects.toThrow(); // Should throw due to invalid paths

        // Check that the deleter was called for all valid paths that would have been copied
        // The copier mock throws on the first invalid asset.
        // Assets are copied *after* data.json is committed.
        // If copyAssets fails, cleanup is called for assets *already processed by copyAssets*
        // In this test, the first invalid asset will stop copyAssets.
        // The current event_log_storage.js implementation copies assets one by one, and if one fails,
        // it throws, and then cleanupAssets is called for *all* assets in newAssets.
        // So, deleter should be called for all original asset paths if the source file existed.

        // The copier mock will throw when it encounters the first invalid_asset.
        // The `cleanupAssets` function is then called with `eventLogStorage.getNewAssets()`,
        // which contains all assets (valid and invalid).
        // `deleter.deleteFile` is then called for each of these.
        // The mock for `deleter.deleteFile` doesn't care if the file exists.
        allAssets.forEach((assetItem) => {
            // cleanupAssets deletes the copied files at their target paths
            const expected = targetPath(capabilities, assetItem);
            expect(capabilities.deleter.deleteFile).toHaveBeenCalledWith(
                expected
            );
        });

        // Verify that the transaction was rolled back and event wasn't stored
        await gitstore.transaction(capabilities, async (store) => {
            const workTree = await store.getWorkTree();
            const dataPath = path.join(workTree, "data.json");

            // Check if data.json exists or not
            const fileExists = await fsp
                .access(dataPath)
                .then(() => true)
                .catch(() => false);

            // Either the file doesn't exist (good) or it doesn't contain our event (also good)
            let found = false;
            if (fileExists) {
                const objects = await readObjects(dataPath);
                const serializedEvent = event.serialize(testEvent);
                found = objects.some(
                    (obj) =>
                        obj.id?.identifier === serializedEvent.id?.identifier
                );
            } else {
                // Test passes if the file doesn't exist - no events were committed
            }

            expect(found).toBe(false);
        });
    });

    test("getExistingEntries returns entries that were already in data.json", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

        // First transaction: create initial entries
        const firstEvent = {
            id: { identifier: "existing1" },
            date: new Date("2025-05-01"),
            original: "first input",
            input: "processed first input",
            modifiers: { test: "first" },
            type: "existing_event",
            description: "First existing event",
        };

        await transaction(capabilities, async (storage) => {
            storage.addEntry(firstEvent, []);
        });

        // Second transaction: verify we can read existing entries and add more
        const secondEvent = {
            id: { identifier: "new1" },
            date: new Date("2025-05-15"),
            original: "new input",
            input: "processed new input",
            modifiers: { test: "new" },
            type: "new_event",
            description: "New event added after checking existing",
        };

        await transaction(capabilities, async (storage) => {
            // Check that we can read the existing entries
            const existingEntries = await storage.getExistingEntries();
            expect(existingEntries).toHaveLength(1);
            expect(existingEntries[0].id).toEqual(
                event.serialize(firstEvent).id
            );

            // Now add a new entry
            storage.addEntry(secondEvent, []);
        });

        // Verify both entries are now in data.json
        await gitstore.transaction(capabilities, async (store) => {
            const workTree = await store.getWorkTree();
            const dataPath = path.join(workTree, "data.json");
            const objects = await readObjects(dataPath);
            expect(objects).toHaveLength(2);
            expect(objects[0].id).toEqual(event.serialize(firstEvent).id);
            expect(objects[1].id).toEqual(event.serialize(secondEvent).id);
        });
    });

    test("getExistingEntries caches results to avoid repeated file reads", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

        // First create an initial entry
        const initialEvent = {
            id: { identifier: "cache-test" },
            date: new Date("2025-05-24"),
            original: "cache test",
            input: "cache test input",
            type: "cache_test",
            description: "Testing getExistingEntries caching",
        };

        await transaction(capabilities, async (storage) => {
            storage.addEntry(initialEvent, []);
        });

        // Patch the file read function to count reads
        const jsonStreamFile = require("../src/json_stream_file");
        const originalReadObjects = jsonStreamFile.readObjects;
        let readCount = 0;
        jsonStreamFile.readObjects = async function (...args) {
            readCount++;
            return await originalReadObjects.apply(this, args);
        };

        try {
            // Now run a new transaction to test caching
            await transaction(capabilities, async (storage) => {
                // First call should read the file
                const firstResult = await storage.getExistingEntries();
                expect(firstResult).toHaveLength(1);
                expect(readCount).toBe(1);

                // Second call should use the cache
                const secondResult = await storage.getExistingEntries();
                expect(secondResult).toHaveLength(1);
                expect(readCount).toBe(1); // Still only called once

                // Both results should be identical
                expect(secondResult).toBe(firstResult); // Same reference

                // Ensure there is always something to commit
                storage.addEntry(
                    {
                        id: { identifier: "cache-test-2" },
                        date: new Date("2025-05-25"),
                        original: "cache test 2",
                        input: "cache test input 2",
                        type: "cache_test",
                        description: "Testing getExistingEntries caching 2",
                    },
                    []
                );
            });
        } finally {
            // Restore the original function
            jsonStreamFile.readObjects = originalReadObjects;
        }
    });
});
