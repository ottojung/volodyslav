const fs = require("fs").promises;
const path = require("path");
const config = require("../src/config");
const configStorage = require("../src/config/storage");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime } = require("./stubs");
const temporary = require("./temporary");

beforeEach(temporary.beforeEach);
afterEach(temporary.afterEach);

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

async function getTestPath() {
    const testDir = temporary.input();
    await fs.mkdir(testDir, { recursive: true });
    return path.join(testDir, "test-config.json");
}

describe("config storage", () => {
    describe("file I/O operations", () => {
        describe("readConfig", () => {
            it("should read and deserialize a valid config file", async () => {
                const testFile = await getTestPath();
                const capabilities = getTestCapabilities();

                const testConfig = {
                    help: "Test configuration file",
                    shortcuts: [
                        ["test", "TEST"],
                        ["hello", "Hello World", "Greeting shortcut"],
                    ],
                };

                await fs.writeFile(testFile, JSON.stringify(testConfig));
                const file = await capabilities.checker.instantiate(testFile);

                const result = await configStorage.readConfig(
                    capabilities,
                    file
                );

                expect(result).toEqual({
                    help: "Test configuration file",
                    shortcuts: [
                        { pattern: "test", replacement: "TEST" },
                        {
                            pattern: "hello",
                            replacement: "Hello World",
                            description: "Greeting shortcut",
                        },
                    ],
                });
            });

            it("should return null for empty files", async () => {
                const testFile = await getTestPath();
                const capabilities = getTestCapabilities();

                await fs.writeFile(testFile, "");
                const file = await capabilities.checker.instantiate(testFile);

                const result = await configStorage.readConfig(
                    capabilities,
                    file
                );

                expect(config.isInvalidStructureError(result)).toBe(true);
                expect(result.message).toBe("Config file is empty");
            });

            it("should return null for invalid config format", async () => {
                const testFile = await getTestPath();
                const capabilities = getTestCapabilities();

                const invalidConfig = { invalid: "format" };
                await fs.writeFile(testFile, JSON.stringify(invalidConfig));
                const file = await capabilities.checker.instantiate(testFile);

                const result = await configStorage.readConfig(
                    capabilities,
                    file
                );

                expect(config.isMissingFieldError(result)).toBe(true);
                expect(result.field).toBe("help");
            });

            it("should handle multiple objects and use first one", async () => {
                const testFile = await getTestPath();
                const capabilities = getTestCapabilities();

                const validConfig1 = {
                    help: "First config",
                    shortcuts: [["test1", "TEST1"]],
                };
                const validConfig2 = {
                    help: "Second config",
                    shortcuts: [["test2", "TEST2"]],
                };

                const content =
                    JSON.stringify(validConfig1) +
                    "\n" +
                    JSON.stringify(validConfig2);
                await fs.writeFile(testFile, content);
                const file = await capabilities.checker.instantiate(testFile);

                const result = await configStorage.readConfig(
                    capabilities,
                    file
                );

                expect(result).toEqual({
                    help: "First config",
                    shortcuts: [{ pattern: "test1", replacement: "TEST1" }],
                });
                // Note: readConfig no longer logs warnings for multiple objects,
                // it just uses the first one silently
            });
        });

        describe("writeConfig", () => {
            it("should serialize and write config to file", async () => {
                const testFile = await getTestPath();
                const capabilities = getTestCapabilities();

                const configObj = {
                    help: "Test config to write",
                    shortcuts: [
                        { pattern: "test", replacement: "TEST" },
                        {
                            pattern: "hello",
                            replacement: "Hello World",
                            description: "Greeting",
                        },
                    ],
                };

                await configStorage.writeConfig(
                    capabilities,
                    testFile,
                    configObj
                );

                // Verify file was created and contains correct content
                const content = await fs.readFile(testFile, "utf8");
                const parsed = JSON.parse(content.trim());

                expect(parsed).toEqual({
                    help: "Test config to write",
                    shortcuts: [
                        ["test", "TEST"],
                        ["hello", "Hello World", "Greeting"],
                    ],
                });

                // Verify logging
                expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                    {
                        filepath: testFile,
                        shortcutCount: 2,
                    },
                    "Config file written successfully"
                );
            });

            it("should create directories if they don't exist", async () => {
                const capabilities = getTestCapabilities();
                const nestedPath = path.join(
                    temporary.input(),
                    "nested",
                    "deep",
                    "config.json"
                );

                const configObj = configStorage.createDefaultConfig();

                await configStorage.writeConfig(
                    capabilities,
                    nestedPath,
                    configObj
                );

                // Verify file was created
                const fileExists = await fs
                    .access(nestedPath)
                    .then(() => true)
                    .catch(() => false);
                expect(fileExists).toBe(true);

                const content = await fs.readFile(nestedPath, "utf8");
                const parsed = JSON.parse(content.trim());
                expect(parsed.help).toBe(configObj.help);
            });

            it("should handle write errors gracefully", async () => {
                const capabilities = getTestCapabilities();
                const configObj = configStorage.createDefaultConfig();

                // Override creator to throw error
                capabilities.creator.createFile = jest
                    .fn()
                    .mockRejectedValue(new Error("Permission denied"));

                await expect(
                    configStorage.writeConfig(
                        capabilities,
                        "/invalid/path/config.json",
                        configObj
                    )
                ).rejects.toThrow("Permission denied");

                expect(capabilities.logger.logError).toHaveBeenCalledWith(
                    {
                        filepath: "/invalid/path/config.json",
                        error: "Permission denied",
                    },
                    "Failed to write config file"
                );
            });

            it("should format JSON with proper indentation", async () => {
                const testFile = await getTestPath();
                const capabilities = getTestCapabilities();

                const configObj = {
                    help: "Formatting test",
                    shortcuts: [
                        {
                            pattern: "test",
                            replacement: "TEST",
                            description: "Test description",
                        },
                    ],
                };

                await configStorage.writeConfig(
                    capabilities,
                    testFile,
                    configObj
                );

                const content = await fs.readFile(testFile, "utf8");

                // Should be properly indented with tabs
                expect(content).toContain('\t"help":');
                expect(content).toContain('\t"shortcuts":');
                expect(content).toMatch(/\t\t\[\n\t\t\t/); // Nested array formatting
                expect(content.endsWith("\n")).toBe(true); // Should end with newline
            });
        });
    });

});
