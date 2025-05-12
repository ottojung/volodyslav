const fs = require("fs").promises;
const path = require("path");
const { transaction } = require("../src/event_log_storage");
const { transaction: gitstoreTransaction } = require("../src/gitstore");
const temporary = require("./temporary");
const makeTestRepository = require("./make_test_repository");

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
        await gitstoreTransaction(gitDir, async (store) => {
            const workTree = await store.getWorkTree();
            const dataPath = path.join(workTree, "data.json");
            const fileContent = await fs.readFile(dataPath, "utf8");
            const storedEvent = JSON.parse(fileContent.trim()); // trim to remove trailing newline
            expect(storedEvent).toEqual(testEvent);
        });
    });
});
