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
        logLevel: jest.fn().mockReturnValue("debug"),
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
            description: "Test event description",
        };

        await transaction(async (eventLogStorage) => {
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
        const { gitDir } = await makeTestRepository();

        const event1 = {
            id: { identifier: "event1" },
            date: "2025-05-12",
            original: "first input",
            input: "processed first input",
            modifiers: { foo: "bar" },
            type: "first_event",
            description: "First event description",
        };
        const event2 = {
            id: { identifier: "event2" },
            date: "2025-05-12",
            original: "second input",
            input: "processed second input",
            modifiers: { baz: "qux" },
            type: "second_event",
            description: "Second event description",
        };

        await transaction(async (eventLogStorage) => {
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
        // Expect the transaction to fail due to no staged changes to commit
        await expect(
            transaction(async () => {
                // no entries added
            })
        ).rejects.toThrow();
    });

    test("transaction copies asset files into repository", async () => {
        const { gitDir } = await makeTestRepository();
        // create a dummy asset file
        const assetsDir = temporary.input();
        const assetFile = path.join(assetsDir, "dummy.txt");
        await require("fs").promises.mkdir(assetsDir, { recursive: true });
        await require("fs").promises.writeFile(assetFile, "hello asset");
        // define a fake event and asset
        const testEvent = {
            id: { identifier: "assetEvent" },
            date: "2025-05-13",
            original: "",
            input: "",
            modifiers: {},
            type: "evt",
            description: "",
        };
        const asset = { identifier: testEvent.id, path: assetFile };
        // run transaction
        await transaction(async (storage) => {
            storage.addEntry(testEvent, [asset]);
        });
        // verify asset in repo worktree
        await gitstore.transaction(gitDir, async (store) => {
            const workTree = await store.getWorkTree();
            const targetPath = path.join(
                workTree,
                testEvent.id.identifier,
                "dummy.txt"
            );
            const content = await require("fs").promises.readFile(
                targetPath,
                "utf8"
            );
            expect(content).toBe("hello asset");
        });
    });

    test("asset cleanup on transaction failure", async () => {
        // create dummy asset file
        const assetsDir = temporary.input();
        const assetFile = path.join(assetsDir, "toDelete.txt");
        await require("fs").promises.mkdir(assetsDir, { recursive: true });
        await require("fs").promises.writeFile(assetFile, "will be deleted");
        const testEvent = {
            id: { identifier: "cleanupEvent" },
            date: "",
            original: "",
            input: "",
            modifiers: {},
            type: "",
            description: "",
        };
        const asset = { identifier: testEvent.id, path: assetFile };
        // run transaction that throws after adding asset
        await expect(
            transaction(async (storage) => {
                storage.addEntry(testEvent, [asset]);
                throw new Error("forced failure");
            })
        ).rejects.toThrow("forced failure");
        // wait for cleanup to run
        await new Promise((res) => setTimeout(res, 50));
        // original asset file should be removed
        expect(require("fs").existsSync(assetFile)).toBe(false);
    });
});
