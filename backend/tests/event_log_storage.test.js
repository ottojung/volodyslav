jest.mock("fs/promises", () => {
    const actual = jest.requireActual("fs/promises");
    return {
        ...actual,
        copyFile: jest.fn().mockResolvedValue(),
        unlink: jest.fn().mockResolvedValue(),
    };
});
const path = require("path");
const { transaction } = require("../src/event_log_storage");
const fsp = require("fs/promises");
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
        logLevel: jest.fn().mockReturnValue("debug"),
        eventLogAssetsDirectory: jest.fn().mockImplementation(() => {
            const dir = temporary.input();
            return path.join(dir, "event_log_assets");
        }),
        eventLogDirectory: jest.fn().mockImplementation(() => {
            const dir = temporary.input();
            return path.join(dir, "event_log");
        }),
    };
});

describe("event_log_storage", () => {
    // No stubbing: use real gitstore.transaction with makeTestRepository per test

    test("transaction allows adding and storing event entries", async () => {
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
        const deleter = { delete: jest.fn() };
        await makeTestRepository();
        // Spy on copyFile to verify correct invocation
        const copySpy = jest.spyOn(fsp, "copyFile").mockResolvedValue();
        const testEvent = {
            id: { identifier: "assetEvent" },
            date: new Date("2025-05-13"),
        };
        const assetPath = "/some/asset.txt";
        await transaction(deleter, async (storage) =>
            storage.addEntry(testEvent, [{ event: testEvent, path: assetPath }])
        );
        expect(copySpy).toHaveBeenCalledTimes(1);
        const [src, dest] = copySpy.mock.calls[0];
        expect(src).toBe(assetPath);
        expect(dest).toContain(`/assetEvent`);
        copySpy.mockRestore();
    });

    test("transaction cleanup calls unlink for each asset on failure", async () => {
        const deleter = { delete: jest.fn() };
        await makeTestRepository();
        const testEvent = { id: { identifier: "cleanupEvent" } };
        const assetPath = "/some/failure.txt";
        await expect(
            transaction(deleter, async (storage) => {
                storage.addEntry(testEvent, [
                    { identifier: testEvent.id, path: assetPath },
                ]);
                throw new Error("forced failure");
            })
        ).rejects.toThrow("forced failure");
        expect(deleter.delete).toHaveBeenCalledWith(assetPath);
    });
});
