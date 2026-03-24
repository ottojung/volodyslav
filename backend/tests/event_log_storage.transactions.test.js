const { transaction } = require("../src/event_log_storage");
const { fromISOString } = require("../src/datetime");
const { makeFromData } = require("../src/filesystem/file_ref");
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
        creator: {
            name: "test",
            uuid: "test-uuid",
            version: "1.0.0",
            hostname: "test-host",
        },
    };
}

describe("event_log_storage transaction", () => {
    test("stores new entries in the incremental graph", async () => {
        const capabilities = getTestCapabilities();

        await transaction(capabilities, async (storage) => {
            storage.addEntry(makeEvent("event-1", "first"), []);
            storage.addEntry(makeEvent("event-2", "second"), []);
        });

        const events = await capabilities.interface.getAllEvents();
        expect(events.map((entry) => entry.id.identifier)).toEqual([
            "event-1",
            "event-2",
        ]);
    });

    test("updates the graph only after asset copies succeed", async () => {
        const capabilities = getTestCapabilities();
        const failingAsset = {
            event: makeEvent("event-1", "with asset"),
            file: makeFromData("file.mp3", () =>
                Promise.reject(new Error("simulated read failure"))
            ),
        };

        await expect(
            transaction(capabilities, async (storage) => {
                storage.addEntry(failingAsset.event, [failingAsset]);
            })
        ).rejects.toThrow();

        await expect(capabilities.interface.getAllEvents()).resolves.toEqual([]);
    });

    test("supports read-only transactions", async () => {
        const capabilities = getTestCapabilities();

        await expect(
            transaction(capabilities, async () => {})
        ).resolves.toBeUndefined();
    });
});
