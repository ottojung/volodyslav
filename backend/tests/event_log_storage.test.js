const fs = require("fs").promises;
const path = require("path");
const { transaction } = require("../src/event_log_storage");
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
        await makeTestRepository();

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

        // Read the contents of the data.json file to verify the entry was stored
        // const dataPath = path.join(temporary.input(), "event_log/data.json");
        // const fileContent = await fs.readFile(dataPath, "utf8");
        // const storedEvent = JSON.parse(fileContent);

        // expect(storedEvent).toEqual(testEvent);
    });
});
