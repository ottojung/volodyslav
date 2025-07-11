const path = require("path");
const { transaction } = require("../src/event_log_storage");
const gitstore = require("../src/gitstore");
const { readObjects } = require("../src/json_stream_file");
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

describe("event_log_storage", () => {
    test("transaction supports config reading and writing", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

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

        // First transaction: write config
        await transaction(capabilities, async (storage) => {
            storage.setConfig(testConfig);
        });

        // Second transaction: read config and verify
        await transaction(capabilities, async (storage) => {
            const readConfig = await storage.getExistingConfig();
            expect(readConfig).toEqual(testConfig);

            // Also verify we can read it again (caching)
            const readConfig2 = await storage.getExistingConfig();
            expect(readConfig2).toBe(readConfig); // Same reference due to caching
        });

        // Verify config persisted in git repository
        await gitstore.transaction(capabilities, async (store) => {
            const workTree = await store.getWorkTree();
            const configPath = path.join(workTree, "config.json");

            const fileExists = await capabilities.checker.fileExists(configPath);
            expect(fileExists).not.toBeNull();

            const configFile = await capabilities.checker.instantiate(configPath);
            const configStorage = require("../src/config/storage");
            const storedConfig = await configStorage.readConfig(
                capabilities,
                configFile
            );

            expect(storedConfig).toEqual(testConfig);
        });
    });

    test("transaction handles missing config.json gracefully", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

        await transaction(capabilities, async (storage) => {
            // Should not throw when config.json doesn't exist
            const config = await storage.getExistingConfig();
            expect(config).toBeNull();
        });
    });

    test("transaction can update existing config", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

        const initialConfig = {
            help: "Initial config",
            shortcuts: [{ pattern: "init", replacement: "initialize" }],
        };

        const updatedConfig = {
            help: "Updated config",
            shortcuts: [
                { pattern: "init", replacement: "initialize" },
                {
                    pattern: "upd",
                    replacement: "update",
                    description: "Update shortcut",
                },
            ],
        };

        // Create initial config
        await transaction(capabilities, async (storage) => {
            storage.setConfig(initialConfig);
        });

        // Update config
        await transaction(capabilities, async (storage) => {
            const existing = await storage.getExistingConfig();
            expect(existing).toEqual(initialConfig);

            storage.setConfig(updatedConfig);
        });

        // Verify updated config
        await transaction(capabilities, async (storage) => {
            const final = await storage.getExistingConfig();
            expect(final).toEqual(updatedConfig);
        });
    });

    test("transaction commits when both entries and config are added", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

        const testEvent = {
            id: { identifier: "config-and-event" },
            date: capabilities.datetime.fromISOString("2025-05-20"),
            original: "test with config",
            input: "test with config",
            type: "config_test",
            description: "Test event with config",
            creator: { name: "test", uuid: "test-uuid", version: "1.0.0" },
        };

        const testConfig = {
            help: "Config with event",
            shortcuts: [{ pattern: "evt", replacement: "event" }],
        };

        await transaction(capabilities, async (storage) => {
            storage.addEntry(testEvent, []);
            storage.setConfig(testConfig);
        });

        // Verify both were persisted
        await gitstore.transaction(capabilities, async (store) => {
            const workTree = await store.getWorkTree();

            // Check data.json
            const dataPath = path.join(workTree, "data.json");
            const dataFile = await capabilities.checker.instantiate(dataPath);
            const objects = await readObjects(capabilities, dataFile);
            expect(objects).toHaveLength(1);
            expect(objects[0].id).toBe("config-and-event");

            // Check config.json
            const configPath = path.join(workTree, "config.json");
            const configFile = await capabilities.checker.instantiate(configPath);
            const configStorage = require("../src/config/storage");
            const storedConfig = await configStorage.readConfig(
                capabilities,
                configFile
            );
            expect(storedConfig).toEqual(testConfig);
        });
    });
});
