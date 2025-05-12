const fs = require("fs").promises;
const path = require("path");
const { transaction } = require("../src/event_log_storage");
const gitstore = require("../src/gitstore");
const temporary = require("./temporary");
const makeTestRepository = require("./make_test_repository");
const event = require("../src/event/event");

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
            const fileContent = await fs.readFile(dataPath, "utf8");
            const storedEvent = JSON.parse(fileContent.trim()); // trim to remove trailing newline
            expect(storedEvent).toEqual(event.serialize(testEvent));
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
            const fileContent = await fs.readFile(dataPath, "utf8");
            // Group lines into JSON blocks between '{' and '}'
            const lines = fileContent.trim().split("\n");
            const blocks = [];
            let current = [];
            for (const line of lines) {
                current.push(line);
                if (line.trim() === "}") {
                    blocks.push(current.join("\n"));
                    current = [];
                }
            }
            expect(blocks).toHaveLength(2);
            const [storedEvent1, storedEvent2] = blocks.map((block) => JSON.parse(block));
            expect(storedEvent1).toEqual(event.serialize(event1));
            expect(storedEvent2).toEqual(event.serialize(event2));
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
