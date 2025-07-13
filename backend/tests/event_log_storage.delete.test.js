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

describe("event_log_storage deletion", () => {
    test("transaction allows deleting existing entries", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

        const e1 = {
            id: { identifier: "delete1" },
            date: capabilities.datetime.fromISOString("2025-05-12"),
            original: "first",
            input: "first",
            type: "test",
            description: "first",
            creator: { name: "t", uuid: "u", version: "1" },
        };
        const e2 = {
            id: { identifier: "delete2" },
            date: capabilities.datetime.fromISOString("2025-05-13"),
            original: "second",
            input: "second",
            type: "test",
            description: "second",
            creator: { name: "t", uuid: "u", version: "1" },
        };

        await transaction(capabilities, async (s) => {
            s.addEntry(e1, []);
            s.addEntry(e2, []);
        });

        await transaction(capabilities, async (s) => {
            s.deleteEntry(e1.id);
        });

        await gitstore.transaction(capabilities, "working-git-repository", capabilities.environment.eventLogRepository(), async (store) => {
            const workTree = await store.getWorkTree();
            const dataPath = path.join(workTree, "data.json");
            const dataFile = await capabilities.checker.instantiate(dataPath);
            const objects = await readObjects(capabilities, dataFile);
            expect(objects).toHaveLength(1);
            expect(objects[0].id).toBe(event.serialize(e2).id);
        });
    });

    test("deleteEntry removes entry queued in same transaction", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

        const e1 = {
            id: { identifier: "todel1" },
            date: capabilities.datetime.fromISOString("2025-05-14"),
            original: "one",
            input: "one",
            type: "test",
            description: "one",
            creator: { name: "t", uuid: "u", version: "1" },
        };
        const e2 = {
            id: { identifier: "todel2" },
            date: capabilities.datetime.fromISOString("2025-05-15"),
            original: "two",
            input: "two",
            type: "test",
            description: "two",
            creator: { name: "t", uuid: "u", version: "1" },
        };

        await transaction(capabilities, async (s) => {
            s.addEntry(e1, []);
            s.addEntry(e2, []);
            s.deleteEntry(e1.id);
        });

        await gitstore.transaction(capabilities, "working-git-repository", capabilities.environment.eventLogRepository(), async (store) => {
            const workTree = await store.getWorkTree();
            const dataPath = path.join(workTree, "data.json");
            const dataFile = await capabilities.checker.instantiate(dataPath);
            const objects = await readObjects(capabilities, dataFile);
            expect(objects).toHaveLength(1);
            expect(objects[0].id).toBe(event.serialize(e2).id);
        });
    });

    test("deleting the only entry results in empty log", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

        const e1 = {
            id: { identifier: "solo" },
            date: capabilities.datetime.fromISOString("2025-05-16"),
            original: "solo",
            input: "solo",
            type: "test",
            description: "solo",
            creator: { name: "t", uuid: "u", version: "1" },
        };

        await transaction(capabilities, async (s) => {
            s.addEntry(e1, []);
        });

        await transaction(capabilities, async (s) => {
            s.deleteEntry(e1.id);
        });

        await gitstore.transaction(capabilities, "working-git-repository", capabilities.environment.eventLogRepository(), async (store) => {
            const workTree = await store.getWorkTree();
            const dataPath = path.join(workTree, "data.json");
            const dataFile = await capabilities.checker.instantiate(dataPath);
            const objects = await readObjects(capabilities, dataFile);
            expect(objects).toHaveLength(0);
        });
    });

    test("getDeletedIds returns an iterator of EventIds", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

        const e = {
            id: { identifier: "iter" },
            date: capabilities.datetime.fromISOString("2025-06-01"),
            original: "i",
            input: "i",
            type: "test",
            description: "iter",
            creator: { name: "t", uuid: "u", version: "1" },
        };

        await transaction(capabilities, async (s) => {
            s.addEntry(e, []);
        });

        await transaction(capabilities, async (s) => {
            s.deleteEntry(e.id);
            const iter = s.getDeletedIds();
            expect(typeof iter[Symbol.iterator]).toBe("function");
            const arr = Array.from(iter);
            expect(arr).toHaveLength(1);
            expect(arr[0]).toEqual(e.id);
        });
    });

    test("transaction can delete multiple entries in one call", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

        const e1 = {
            id: { identifier: "multi1" },
            date: capabilities.datetime.fromISOString("2025-06-02"),
            original: "m1",
            input: "m1",
            type: "test",
            description: "m1",
            creator: { name: "t", uuid: "u", version: "1" },
        };
        const e2 = {
            id: { identifier: "multi2" },
            date: capabilities.datetime.fromISOString("2025-06-03"),
            original: "m2",
            input: "m2",
            type: "test",
            description: "m2",
            creator: { name: "t", uuid: "u", version: "1" },
        };

        await transaction(capabilities, async (s) => {
            s.addEntry(e1, []);
            s.addEntry(e2, []);
        });

        await transaction(capabilities, async (s) => {
            s.deleteEntry(e1.id);
            s.deleteEntry(e2.id);
        });

        await gitstore.transaction(capabilities, "working-git-repository", capabilities.environment.eventLogRepository(), async (store) => {
            const workTree = await store.getWorkTree();
            const dataPath = path.join(workTree, "data.json");
            const dataFile = await capabilities.checker.instantiate(dataPath);
            const objects = await readObjects(capabilities, dataFile);
            expect(objects).toHaveLength(0);
        });
    });
});
