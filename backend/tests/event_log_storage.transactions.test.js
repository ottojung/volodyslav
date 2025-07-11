const path = require("path");
const { transaction } = require("../src/event_log_storage");
const gitstore = require("../src/gitstore");
const { readObjects } = require("../src/json_stream_file");
const event = require("../src/event/structure");
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
    test("transaction allows adding and storing event entries", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

        const testEvent = {
            id: { identifier: "test123" },
            date: capabilities.datetime.fromISOString("2025-05-12"),
            original: "test input",
            input: "processed test input",
            modifiers: { test: "modifier" },
            type: "test_event",
            description: "Test event description",
            creator: { name: "test", uuid: "test-uuid", version: "1.0.0" },
        };

        await transaction(capabilities, async (eventLogStorage) => {
            eventLogStorage.addEntry(testEvent, []);
        });

        // Verify the stored event using gitstore transaction
        await gitstore.transaction(capabilities, async (store) => {
            const workTree = await store.getWorkTree();
            const dataPath = path.join(workTree, "data.json");
            const dataFile = await capabilities.checker.instantiate(dataPath);
            const objects = await readObjects(capabilities, dataFile);
            expect(objects).toHaveLength(1);
            expect(objects[0]).toEqual(event.serialize(testEvent));
        });
    });

    test("transaction fails if git fails", async () => {
        const capabilities = getTestCapabilities();

        // Note: didn't use stubEventLogRepository here to avoid creating a real git repo.

        const testEvent = {
            id: { identifier: "test123" },
            date: capabilities.datetime.fromISOString("2025-05-12"),
            original: "test input",
            input: "processed test input",
            modifiers: { test: "modifier" },
            type: "test_event",
            description: "Test event description",
            creator: { name: "test", uuid: "test-uuid", version: "1.0.0" },
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
            date: capabilities.datetime.fromISOString("2025-05-12"),
            original: "first input",
            input: "processed first input",
            modifiers: { foo: "bar" },
            type: "first_event",
            description: "First event description",
        };
        const event2 = {
            id: { identifier: "event2" },
            date: capabilities.datetime.fromISOString("2025-05-12"),
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
            const dataFile = await capabilities.checker.instantiate(dataPath);
            const objects = await readObjects(capabilities, dataFile);
            expect(objects).toHaveLength(2);
            expect(objects[0]).toEqual(event.serialize(event1));
            expect(objects[1]).toEqual(event.serialize(event2));
        });
    });

    test("transaction with no entries succeeds without committing", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);
        // Read-only transactions should succeed without committing changes
        await expect(
            transaction(capabilities, async () => {
                // no entries added - this should be allowed for read-only operations
            })
        ).resolves.not.toThrow();
    });
});
