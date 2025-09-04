const path = require("path");
const { transaction } = require("../src/event_log_storage");
const gitstore = require("../src/gitstore");
const { readObjects } = require("../src/json_stream_file");
const event = require("../src/event/structure");
const { fromISOString } = require("../src/datetime");
const {
    stubEnvironment,
    stubLogger,
    stubDatetime,
    stubEventLogRepository,
} = require("./stubs");
const { getMockedRootCapabilities } = require("./spies");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

describe("event_log_storage", () => {
    // No stubbing: use real gitstore.transaction with stubEventLogRepository per test

    test("getExistingEntries returns entries that were already in data.json", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

        // First transaction: create initial entries
        const firstEvent = {
            id: { identifier: "existing1" },
            date: fromISOString("2025-05-01"),
            original: "first input",
            input: "processed first input",
            modifiers: { test: "first" },
            type: "existing_event",
            description: "First existing event",
            creator: { name: "test", uuid: "test-uuid", version: "1.0.0" },
        };

        await transaction(capabilities, async (storage) => {
            storage.addEntry(firstEvent, []);
        });

        // Second transaction: verify we can read existing entries and add more
        const secondEvent = {
            id: { identifier: "new1" },
            date: fromISOString("2025-05-15"),
            original: "new input",
            input: "processed new input",
            modifiers: { test: "new" },
            type: "new_event",
            description: "New event added after checking existing",
            creator: { name: "test", uuid: "test-uuid", version: "1.0.0" },
        };

        await transaction(capabilities, async (storage) => {
            // Check that we can read the existing entries
            const existingEntries = await storage.getExistingEntries();
            expect(existingEntries).toHaveLength(1);
            expect(existingEntries[0].id.identifier).toEqual(
                event.serialize(capabilities, firstEvent).id
            );

            // Now add a new entry
            storage.addEntry(secondEvent, []);
        });

        // Verify both entries are now in data.json
        await gitstore.transaction(capabilities, "working-git-repository", capabilities.environment.eventLogRepository(), async (store) => {
            const workTree = await store.getWorkTree();
            const dataPath = path.join(workTree, "data.json");
            const dataFile = await capabilities.checker.instantiate(dataPath);
            const objects = await readObjects(capabilities, dataFile);
            expect(objects).toHaveLength(2);
            expect(objects[0].id).toEqual(event.serialize(capabilities, firstEvent).id);
            expect(objects[1].id).toEqual(event.serialize(capabilities, secondEvent).id);
        });
    });

    test("getExistingEntries caches results to avoid repeated file reads", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

        // First create an initial entry
        const initialEvent = {
            id: { identifier: "cache-test" },
            date: fromISOString("2025-05-24"),
            original: "cache test",
            input: "cache test input",
            type: "cache_test",
            description: "Testing getExistingEntries caching",
            creator: { name: "test", uuid: "test-uuid", version: "1.0.0" },
        };

        await transaction(capabilities, async (storage) => {
            storage.addEntry(initialEvent, []);
        });

        // Count calls to createReadStream (already a jest mock in spies.js)
        const reader = capabilities.reader;
        expect(reader.createReadStream).toHaveBeenCalledTimes(0);

        // Now run a new transaction to test caching
        await transaction(capabilities, async (storage) => {
            expect(reader.createReadStream).toHaveBeenCalledTimes(0);
            // First call should read the file
            const firstResult = await storage.getExistingEntries();
            expect(firstResult).toHaveLength(1);
            expect(reader.createReadStream).toHaveBeenCalledTimes(1);

            // Second call should use the cache
            const secondResult = await storage.getExistingEntries();
            expect(secondResult).toHaveLength(1);
            expect(reader.createReadStream).toHaveBeenCalledTimes(1); // Still called once.

            // Both results should be identical
            expect(secondResult).toBe(firstResult); // Same reference

            // Ensure there is always something to commit
            storage.addEntry(
                {
                    id: { identifier: "cache-test-2" },
                    date: fromISOString("2025-05-25"),
                    original: "cache test 2",
                    input: "cache test input 2",
                    type: "cache_test",
                    description: "Testing getExistingEntries caching 2",
                    creator: {
                        name: "test",
                        uuid: "test-uuid",
                        version: "1.0.0",
                    },
                },
                []
            );
        });
    });

});
