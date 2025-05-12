const path = require("path");
const { transaction } = require("../src/event_log_storage");
const gitstore = require("../src/gitstore");
const { readObjects } = require("../src/json_stream_file");
const temporary = require("./temporary");
const makeTestRepository = require("./make_test_repository");
const event = require("../src/event/structure");

beforeEach(temporary.beforeEach);
afterEach(temporary.afterEach);

// Mock environment exports to avoid real env dependencies
jest.mock("../src/environment", () => {
    const temporary = require("./temporary");
    const path = require("path");
    return {
        eventLogDirectory: jest.fn().mockImplementation(() => {
            const dir = temporary.input();
            return path.join(dir, "event_log");
        }),
    };
});

describe("event_log_storage", () => {
    test("transaction allows adding and storing event entries", async () => {
        const { gitDir } = await makeTestRepository();

        const testEvent = {
            id: { identifier: "test123" },
            date: "2025-05-12",
            original: "test input",
            input: "processed test input",
            modifiers: { test: "modifier" },
            type: "test_event",
            description: "Test event description"
        };

        await transaction(async (eventLogStorage) => {
            eventLogStorage.addEntry(testEvent);
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
        const { gitDir } = await makeTestRepository();

        const event1 = {
            id: { identifier: "event1" },
            date: "2025-05-12",
            original: "first input",
            input: "processed first input",
            modifiers: { foo: "bar" },
            type: "first_event",
            description: "First event description"
        };
        const event2 = {
            id: { identifier: "event2" },
            date: "2025-05-12",
            original: "second input",
            input: "processed second input",
            modifiers: { baz: "qux" },
            type: "second_event",
            description: "Second event description"
        };

        await transaction(async (eventLogStorage) => {
            eventLogStorage.addEntry(event1);
            eventLogStorage.addEntry(event2);
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
        // Expect the transaction to fail due to no staged changes to commit
        await expect(
            transaction(async () => {
                // no entries added
            })
        ).rejects.toThrow();
    });
});
