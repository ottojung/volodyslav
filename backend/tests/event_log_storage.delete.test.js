const { transaction, isEntryNotFoundError } = require("../src/event_log_storage");
const { fromISOString } = require("../src/datetime");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

function makeEvent(id, input) {
    return {
        id: { identifier: id },
        date: fromISOString("2025-05-12T00:00:00.000Z"),
        original: input,
        input,
        creator: { name: "t", uuid: "u", version: "1", hostname: "test-host" },
    };
}

describe("event_log_storage deletion", () => {
    test("removes existing entries from the incremental graph", async () => {
        const capabilities = getTestCapabilities();
        const first = makeEvent("delete-1", "first");
        const second = makeEvent("delete-2", "second");

        await transaction(capabilities, async (storage) => {
            storage.addEntry(first, []);
            storage.addEntry(second, []);
        });

        await transaction(capabilities, async (storage) => {
            storage.deleteEntry(first.id);
        });

        const events = await capabilities.interface.getAllEvents();
        expect(events.map((entry) => entry.id.identifier)).toEqual(["delete-2"]);
    });

    test("absorbs entries added and deleted in the same transaction", async () => {
        const capabilities = getTestCapabilities();
        const first = makeEvent("queued-1", "first");
        const second = makeEvent("queued-2", "second");

        await transaction(capabilities, async (storage) => {
            storage.addEntry(first, []);
            storage.addEntry(second, []);
            storage.deleteEntry(first.id);
        });

        const events = await capabilities.interface.getAllEvents();
        expect(events.map((entry) => entry.id.identifier)).toEqual(["queued-2"]);
    });

    test("throws EntryNotFoundError when deleting a missing entry", async () => {
        const capabilities = getTestCapabilities();
        let thrownError = null;

        await transaction(capabilities, async (storage) => {
            storage.addEntry(makeEvent("existing", "hello"), []);
        });

        try {
            await transaction(capabilities, async (storage) => {
                storage.deleteEntry({ identifier: "missing" });
            });
        } catch (error) {
            thrownError = error;
        }

        expect(isEntryNotFoundError(thrownError)).toBe(true);
        await expect(capabilities.interface.getAllEvents()).resolves.toHaveLength(1);
    });
});
