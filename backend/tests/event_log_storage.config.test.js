const { transaction } = require("../src/event_log_storage");
const { fromISOString } = require("../src/datetime");
const { getMockedRootCapabilities } = require("./spies");
const {
    stubEnvironment,
    stubLogger,
    stubDatetime,
    ensureLiveDatabaseDirectory,
} = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    ensureLiveDatabaseDirectory(capabilities);
    return capabilities;
}

describe("event_log_storage config", () => {
    test("reads back config written by a previous transaction", async () => {
        const capabilities = getTestCapabilities();
        const testConfig = {
            help: "Test configuration for transaction",
            shortcuts: [
                {
                    pattern: "tx",
                    replacement: "transaction",
                    description: "Transaction shortcut",
                },
            ],
        };

        await transaction(capabilities, async (storage) => {
            storage.setConfig(testConfig);
        });

        await transaction(capabilities, async (storage) => {
            const readConfig = await storage.getExistingConfig();
            const cachedConfig = await storage.getExistingConfig();
            expect(readConfig).toEqual(testConfig);
            expect(cachedConfig).toBe(readConfig);
        });

        await expect(capabilities.interface.getConfig()).resolves.toEqual(testConfig);
    });

    test("handles missing graph config gracefully", async () => {
        const capabilities = getTestCapabilities();

        await transaction(capabilities, async (storage) => {
            expect(await storage.getExistingConfig()).toBeNull();
        });
    });

    test("updates config and entries in the same transaction", async () => {
        const capabilities = getTestCapabilities();
        const testEvent = {
            id: { identifier: "config-and-event" },
            date: fromISOString("2025-05-20T00:00:00.000Z"),
            original: "test with config",
            input: "test with config",
            creator: { name: "test", uuid: "uuid", version: "1.0.0", hostname: "test-host" },
        };
        const testConfig = {
            help: "Config with event",
            shortcuts: [{ pattern: "evt", replacement: "event" }],
        };

        await transaction(capabilities, async (storage) => {
            storage.addEntry(testEvent, []);
            storage.setConfig(testConfig);
        });

        await expect(capabilities.interface.getAllEvents()).resolves.toHaveLength(1);
        await expect(capabilities.interface.getConfig()).resolves.toEqual(testConfig);
    });
});
