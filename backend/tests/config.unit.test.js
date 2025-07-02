const { getConfig } = require("../src/config_api");
const { transaction } = require("../src/event_log_storage");
const { getMockedRootCapabilities } = require("./spies");
const {
    stubEnvironment,
    stubLogger,
    stubDatetime,
    stubEventLogRepository,
} = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

describe("getConfig", () => {
    it("returns null when no config exists", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

        const config = await getConfig(capabilities);

        expect(config).toBeNull();
    });

    it("returns existing config when it exists", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

        const testConfig = {
            help: "Test configuration",
            shortcuts: [
                {
                    pattern: "test",
                    replacement: "TEST",
                    description: "Test shortcut",
                },
            ],
        };

        // Set config first
        await transaction(capabilities, async (storage) => {
            storage.setConfig(testConfig);
        });

        // Now get it
        const config = await getConfig(capabilities);

        expect(config).toEqual(testConfig);
    });

    it("logs appropriate information", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

        await getConfig(capabilities);

        expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
            {
                configExists: false,
                shortcutCount: 0,
            },
            "Retrieved config: not found with 0 shortcuts"
        );
    });
});
