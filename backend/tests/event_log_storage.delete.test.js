const path = require("path");
const { transaction } = require("../src/event_log_storage");
const { EventLogStorageClass } = require("../src/event_log_storage/class");
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
            date: new Date("2025-05-12"),
            original: "first",
            input: "first",
            type: "test",
            description: "first",
            creator: { name: "t", uuid: "u", version: "1" },
        };
        const e2 = {
            id: { identifier: "delete2" },
            date: new Date("2025-05-13"),
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

        await gitstore.transaction(capabilities, async (store) => {
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
            date: new Date("2025-05-14"),
            original: "one",
            input: "one",
            type: "test",
            description: "one",
            creator: { name: "t", uuid: "u", version: "1" },
        };
        const e2 = {
            id: { identifier: "todel2" },
            date: new Date("2025-05-15"),
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

        await gitstore.transaction(capabilities, async (store) => {
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
            date: new Date("2025-05-16"),
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

        await gitstore.transaction(capabilities, async (store) => {
            const workTree = await store.getWorkTree();
            const dataPath = path.join(workTree, "data.json");
            const dataFile = await capabilities.checker.instantiate(dataPath);
            const objects = await readObjects(capabilities, dataFile);
            expect(objects).toHaveLength(0);
        });
    });

    test("getDeletedIds returns an iterator", () => {
        const storage = new EventLogStorageClass({});
        const id = { identifier: "iter" };
        storage.deleteEntry(id);
        const iter = storage.getDeletedIds();
        expect(typeof iter.next).toBe("function");
        const ids = [...iter];
        expect(ids).toHaveLength(1);
        expect(ids[0].identifier).toBe("iter");
    });

    test("duplicate deletions are stored once", () => {
        const storage = new EventLogStorageClass({});
        const id = { identifier: "dup" };
        storage.deleteEntry(id);
        storage.deleteEntry(id);
        const ids = [...storage.getDeletedIds()];
        expect(ids).toHaveLength(1);
        expect(ids[0].identifier).toBe("dup");
    });
});
