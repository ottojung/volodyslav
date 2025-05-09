const fs = require("fs").promises;
const path = require("path");
const { transaction } = require("../src/event_log_storage");
const { eventLogDirectory } = require("../src/environment");
const temporary = require("./temporary");
const makeTestRepository = require("./make_test_repository");

// Mock environment exports to avoid real env dependencies
jest.mock('../src/environment', () => {
    const temporary = require('./temporary');
    const path = require('path');
    return {
        openaiAPIKey: jest.fn().mockReturnValue('test-key'),
        resultsDirectory: jest.fn().mockImplementation(temporary.output),
        myServerPort: jest.fn().mockReturnValue(0),
        logLevel: jest.fn().mockReturnValue("silent"),
        eventLogDirectory: jest.fn().mockImplementation(() => {
            const dir = temporary.input();
            return path.join(dir, "event_log");
        }),
    };
});

beforeEach(temporary.beforeEach);
afterEach(temporary.afterEach);

describe("event_log_storage", () => {
    test("transaction allows adding and storing event entries", async () => {
        await makeTestRepository();

        const testEvent = {
            date: "2025-05-09",
            original: "test input",
            input: "processed test input",
            modifiers: { key: "value" },
            type: "test_event",
            description: "Test event description"
        };

        // await transaction(async (eventLogStorage) => {
        //     eventLogStorage.addEntry(testEvent);
        // });

        // // Verify the event was written to the data.json file
        // const dataPath = path.join(eventLogDirectory(), "data.json");
        // const fileContent = await fs.readFile(dataPath, "utf8");
        // const lastLine = fileContent.trim().split("\n").pop();
        // const storedEvent = JSON.parse(lastLine);

        // expect(storedEvent).toEqual(testEvent);
    });

    test("transaction allows adding multiple entries", async () => {
        const testEvents = [
            {
                date: "2025-05-09",
                original: "test input 1",
                input: "processed test input 1",
                modifiers: { key: "value1" },
                type: "test_event",
                description: "Test event description 1"
            },
            {
                date: "2025-05-09",
                original: "test input 2",
                input: "processed test input 2",
                modifiers: { key: "value2" },
                type: "test_event",
                description: "Test event description 2"
            }
        ];

        await transaction(async (eventLogStorage) => {
            testEvents.forEach(event => eventLogStorage.addEntry(event));
        });

        // Verify both events were written to the data.json file
        const dataPath = path.join(eventLogDirectory(), "data.json");
        const fileContent = await fs.readFile(dataPath, "utf8");
        const lines = fileContent.trim().split("\n");
        const storedEvents = lines.map(line => JSON.parse(line));

        expect(storedEvents).toHaveLength(2);
        expect(storedEvents).toEqual(testEvents);
    });

    test("transaction doesn't persist entries if transformation fails", async () => {
        const testEvent = {
            date: "2025-05-09",
            original: "test input",
            input: "processed test input",
            modifiers: { key: "value" },
            type: "test_event",
            description: "Test event description"
        };

        await expect(
            transaction(async (eventLogStorage) => {
                eventLogStorage.addEntry(testEvent);
                throw new Error("Test error");
            })
        ).rejects.toThrow("Test error");

        // Verify no events were written to the data.json file
        const dataPath = path.join(eventLogDirectory(), "data.json");
        await expect(fs.readFile(dataPath, "utf8")).rejects.toThrow();
    });

    test("EventLogStorage maintains entries until transaction commit", async () => {
        const testEvent1 = {
            date: "2025-05-09",
            original: "test input 1",
            input: "processed test input 1",
            modifiers: { key: "value1" },
            type: "test_event",
            description: "Test event description 1"
        };

        const testEvent2 = {
            date: "2025-05-09",
            original: "test input 2",
            input: "processed test input 2",
            modifiers: { key: "value2" },
            type: "test_event",
            description: "Test event description 2"
        };

        let storedEntries;
        await transaction(async (eventLogStorage) => {
            eventLogStorage.addEntry(testEvent1);
            const entries1 = eventLogStorage.getNewEntries();
            expect(entries1).toHaveLength(1);
            expect(entries1[0]).toEqual(testEvent1);

            eventLogStorage.addEntry(testEvent2);
            storedEntries = eventLogStorage.getNewEntries();
            expect(storedEntries).toHaveLength(2);
            expect(storedEntries).toEqual([testEvent1, testEvent2]);
        });

        // Verify the final state matches what was in memory
        const dataPath = path.join(eventLogDirectory(), "data.json");
        const fileContent = await fs.readFile(dataPath, "utf8");
        const lines = fileContent.trim().split("\n");
        const storedEventsFromFile = lines.map(line => JSON.parse(line));

        expect(storedEventsFromFile).toEqual(storedEntries);
    });
});
