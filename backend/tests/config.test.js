const fs = require("fs").promises;
const path = require("path");
const config = require("../src/config");
const configStorage = require("../src/config/storage");
const checker = require("../src/filesystem/checker");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger } = require("./stubs");
const temporary = require("./temporary");

beforeEach(temporary.beforeEach);
afterEach(temporary.afterEach);

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    return capabilities;
}

async function getTestPath() {
    const testDir = temporary.input();
    await fs.mkdir(testDir, { recursive: true });
    return path.join(testDir, "test-config.json");
}

describe("config structure", () => {
    describe("serialize", () => {
        it("should serialize a config with shortcuts to array format", () => {
            const configObj = {
                help: "Test help text",
                shortcuts: [
                    { pattern: "test", replacement: "TEST" },
                    {
                        pattern: "hello",
                        replacement: "Hello World",
                        description: "Greeting",
                    },
                ],
            };

            const result = config.serialize(configObj);

            expect(result).toEqual({
                help: "Test help text",
                shortcuts: [
                    ["test", "TEST"],
                    ["hello", "Hello World", "Greeting"],
                ],
            });
        });

        it("should serialize empty config", () => {
            const configObj = {
                help: "Empty config",
                shortcuts: [],
            };

            const result = config.serialize(configObj);

            expect(result).toEqual({
                help: "Empty config",
                shortcuts: [],
            });
        });

        it("should handle shortcuts without descriptions", () => {
            const configObj = {
                help: "No descriptions",
                shortcuts: [
                    { pattern: "test1", replacement: "TEST1" },
                    { pattern: "test2", replacement: "TEST2" },
                ],
            };

            const result = config.serialize(configObj);

            expect(result).toEqual({
                help: "No descriptions",
                shortcuts: [
                    ["test1", "TEST1"],
                    ["test2", "TEST2"],
                ],
            });
        });
    });

    describe("deserialize", () => {
        it("should deserialize a serialized config back to object format", () => {
            const serializedConfig = {
                help: "Test help text",
                shortcuts: [
                    ["test", "TEST"],
                    ["hello", "Hello World", "Greeting"],
                ],
            };

            const result = config.deserialize(serializedConfig);

            expect(result).toEqual({
                help: "Test help text",
                shortcuts: [
                    { pattern: "test", replacement: "TEST" },
                    {
                        pattern: "hello",
                        replacement: "Hello World",
                        description: "Greeting",
                    },
                ],
            });
        });

        it("should handle shortcuts without descriptions", () => {
            const serializedConfig = {
                help: "No descriptions",
                shortcuts: [
                    ["test1", "TEST1"],
                    ["test2", "TEST2"],
                ],
            };

            const result = config.deserialize(serializedConfig);

            expect(result).toEqual({
                help: "No descriptions",
                shortcuts: [
                    { pattern: "test1", replacement: "TEST1" },
                    { pattern: "test2", replacement: "TEST2" },
                ],
            });
        });

        it("should handle empty shortcuts array", () => {
            const serializedConfig = {
                help: "Empty shortcuts",
                shortcuts: [],
            };

            const result = config.deserialize(serializedConfig);

            expect(result).toEqual({
                help: "Empty shortcuts",
                shortcuts: [],
            });
        });
    });

    describe("tryDeserialize", () => {
        it("should deserialize valid config objects", () => {
            const validObj = {
                help: "Valid config",
                shortcuts: [
                    ["test", "TEST"],
                    ["hello", "Hello World", "Greeting"],
                ],
            };

            const result = config.tryDeserialize(validObj);

            expect(result).toEqual({
                help: "Valid config",
                shortcuts: [
                    { pattern: "test", replacement: "TEST" },
                    {
                        pattern: "hello",
                        replacement: "Hello World",
                        description: "Greeting",
                    },
                ],
            });
        });

        it("should return null for invalid objects", () => {
            const invalidObjects = [
                null,
                undefined,
                "string",
                123,
                [],
                { invalid: "data" },
                { help: "valid", shortcuts: "invalid" },
                { help: 123, shortcuts: [] },
                { help: "valid", shortcuts: [["invalid"]] }, // too few elements
                { help: "valid", shortcuts: [["pattern", 123]] }, // invalid replacement type
                { help: "valid", shortcuts: [["pattern", "replacement", 123]] }, // invalid description type
                { help: "valid", shortcuts: ["not an array"] },
                { shortcuts: [] }, // missing help
                { help: "valid" }, // missing shortcuts
            ];

            invalidObjects.forEach((obj) => {
                expect(config.tryDeserialize(obj)).toBeNull();
            });
        });

        it("should handle edge cases in shortcuts validation", () => {
            // Valid minimal shortcut
            expect(
                config.tryDeserialize({
                    help: "Valid",
                    shortcuts: [["a", "b"]],
                })
            ).not.toBeNull();

            // Valid shortcut with undefined description (should be filtered out)
            expect(
                config.tryDeserialize({
                    help: "Valid",
                    shortcuts: [["a", "b", undefined]],
                })
            ).not.toBeNull();

            // Invalid: too many elements should still work (extra elements ignored)
            expect(
                config.tryDeserialize({
                    help: "Valid",
                    shortcuts: [["a", "b", "c", "d", "e"]],
                })
            ).not.toBeNull();
        });

        it("should validate shortcuts array elements", () => {
            const invalidShortcuts = [
                { help: "test", shortcuts: [null] },
                { help: "test", shortcuts: [{}] },
                { help: "test", shortcuts: [123] },
                { help: "test", shortcuts: ["string"] },
            ];

            invalidShortcuts.forEach((obj) => {
                expect(config.tryDeserialize(obj)).toBeNull();
            });
        });
    });

    describe("roundtrip serialization", () => {
        it("should maintain data integrity through serialize/deserialize cycle", () => {
            const originalConfig = {
                help: "Complex config with various shortcuts",
                shortcuts: [
                    { pattern: "simple", replacement: "SIMPLE" },
                    {
                        pattern: "with-desc",
                        replacement: "WITH-DESC",
                        description: "Has description",
                    },
                    {
                        pattern: "regex\\d+",
                        replacement: "NUMBER_$1",
                        description: "Regex pattern",
                    },
                    { pattern: "", replacement: "" }, // Edge case: empty strings
                ],
            };

            const serialized = config.serialize(originalConfig);
            const deserialized = config.deserialize(serialized);

            expect(deserialized).toEqual(originalConfig);
        });

        it("should work with tryDeserialize", () => {
            const originalConfig = {
                help: "Test config",
                shortcuts: [
                    {
                        pattern: "test",
                        replacement: "TEST",
                        description: "Test shortcut",
                    },
                ],
            };

            const serialized = config.serialize(originalConfig);
            const result = config.tryDeserialize(serialized);

            expect(result).toEqual(originalConfig);
        });
    });
});

describe("config storage", () => {
    describe("utility functions", () => {
        describe("createDefaultConfig", () => {
            it("should create a config with help text and empty shortcuts", () => {
                const defaultConfig = configStorage.createDefaultConfig();

                expect(defaultConfig).toEqual({
                    help: "Welcome to Volodyslav's configuration. Add shortcuts below to customize text replacements.",
                    shortcuts: [],
                });
            });
        });

        describe("addShortcut", () => {
            it("should add a shortcut to existing config immutably", () => {
                const originalConfig = {
                    help: "Test config",
                    shortcuts: [
                        { pattern: "existing", replacement: "EXISTING" },
                    ],
                };

                const newShortcut = {
                    pattern: "new",
                    replacement: "NEW",
                    description: "New shortcut",
                };
                const result = configStorage.addShortcut(
                    originalConfig,
                    newShortcut
                );

                // Original should be unchanged
                expect(originalConfig.shortcuts).toHaveLength(1);

                // Result should have both shortcuts
                expect(result).toEqual({
                    help: "Test config",
                    shortcuts: [
                        { pattern: "existing", replacement: "EXISTING" },
                        {
                            pattern: "new",
                            replacement: "NEW",
                            description: "New shortcut",
                        },
                    ],
                });
            });

            it("should add shortcut to empty config", () => {
                const emptyConfig = configStorage.createDefaultConfig();
                const newShortcut = { pattern: "first", replacement: "FIRST" };

                const result = configStorage.addShortcut(
                    emptyConfig,
                    newShortcut
                );

                expect(result.shortcuts).toHaveLength(1);
                expect(result.shortcuts[0]).toEqual(newShortcut);
            });
        });

        describe("removeShortcut", () => {
            it("should remove shortcut by pattern immutably", () => {
                const originalConfig = {
                    help: "Test config",
                    shortcuts: [
                        { pattern: "keep1", replacement: "KEEP1" },
                        { pattern: "remove", replacement: "REMOVE" },
                        { pattern: "keep2", replacement: "KEEP2" },
                    ],
                };

                const result = configStorage.removeShortcut(
                    originalConfig,
                    "remove"
                );

                // Original should be unchanged
                expect(originalConfig.shortcuts).toHaveLength(3);

                // Result should have shortcut removed
                expect(result).toEqual({
                    help: "Test config",
                    shortcuts: [
                        { pattern: "keep1", replacement: "KEEP1" },
                        { pattern: "keep2", replacement: "KEEP2" },
                    ],
                });
            });

            it("should return unchanged config if pattern not found", () => {
                const originalConfig = {
                    help: "Test config",
                    shortcuts: [
                        { pattern: "existing", replacement: "EXISTING" },
                    ],
                };

                const result = configStorage.removeShortcut(
                    originalConfig,
                    "nonexistent"
                );

                expect(result).toEqual(originalConfig);
                expect(result).not.toBe(originalConfig); // Should be a new object
            });

            it("should handle empty shortcuts array", () => {
                const emptyConfig = configStorage.createDefaultConfig();
                const result = configStorage.removeShortcut(
                    emptyConfig,
                    "anything"
                );

                expect(result).toEqual(emptyConfig);
                expect(result).not.toBe(emptyConfig); // Should be a new object
            });
        });

        describe("findShortcut", () => {
            it("should find shortcut by pattern", () => {
                const testConfig = {
                    help: "Test config",
                    shortcuts: [
                        { pattern: "first", replacement: "FIRST" },
                        {
                            pattern: "second",
                            replacement: "SECOND",
                            description: "Second shortcut",
                        },
                        { pattern: "third", replacement: "THIRD" },
                    ],
                };

                const result = configStorage.findShortcut(testConfig, "second");

                expect(result).toEqual({
                    pattern: "second",
                    replacement: "SECOND",
                    description: "Second shortcut",
                });
            });

            it("should return null if pattern not found", () => {
                const testConfig = {
                    help: "Test config",
                    shortcuts: [
                        { pattern: "existing", replacement: "EXISTING" },
                    ],
                };

                const result = configStorage.findShortcut(
                    testConfig,
                    "nonexistent"
                );

                expect(result).toBeNull();
            });

            it("should return null for empty shortcuts", () => {
                const emptyConfig = configStorage.createDefaultConfig();
                const result = configStorage.findShortcut(
                    emptyConfig,
                    "anything"
                );

                expect(result).toBeNull();
            });

            it("should find first matching shortcut if duplicates exist", () => {
                const testConfig = {
                    help: "Test config",
                    shortcuts: [
                        { pattern: "duplicate", replacement: "FIRST" },
                        { pattern: "duplicate", replacement: "SECOND" },
                    ],
                };

                const result = configStorage.findShortcut(
                    testConfig,
                    "duplicate"
                );

                expect(result).toEqual({
                    pattern: "duplicate",
                    replacement: "FIRST",
                });
            });
        });
    });

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
                const file = await checker.make().instantiate(testFile);

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
                const file = await checker.make().instantiate(testFile);

                const result = await configStorage.readConfig(
                    capabilities,
                    file
                );

                expect(result).toBeNull();
                expect(capabilities.logger.logWarning).toHaveBeenCalledWith(
                    { filepath: file },
                    "Config file is empty"
                );
            });

            it("should return null for invalid config format", async () => {
                const testFile = await getTestPath();
                const capabilities = getTestCapabilities();

                const invalidConfig = { invalid: "format" };
                await fs.writeFile(testFile, JSON.stringify(invalidConfig));
                const file = await checker.make().instantiate(testFile);

                const result = await configStorage.readConfig(
                    capabilities,
                    file
                );

                expect(result).toBeNull();
                expect(capabilities.logger.logWarning).toHaveBeenCalledWith(
                    { filepath: file, invalidObject: invalidConfig },
                    "Found invalid config object in file"
                );
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
                const file = await checker.make().instantiate(testFile);

                const result = await configStorage.readConfig(
                    capabilities,
                    file
                );

                expect(result).toEqual({
                    help: "First config",
                    shortcuts: [{ pattern: "test1", replacement: "TEST1" }],
                });
                expect(capabilities.logger.logWarning).toHaveBeenCalledWith(
                    { filepath: file, objectCount: 2 },
                    "Config file contains multiple objects, using first one"
                );
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

    describe("integration tests", () => {
        it("should support full roundtrip: write -> read -> modify -> write", async () => {
            const testFile = await getTestPath();
            const capabilities = getTestCapabilities();

            // 1. Create and write initial config
            const initialConfig = {
                help: "Integration test config",
                shortcuts: [{ pattern: "initial", replacement: "INITIAL" }],
            };

            await configStorage.writeConfig(
                capabilities,
                testFile,
                initialConfig
            );

            // 2. Read config back
            const file = await checker.make().instantiate(testFile);
            const readConfig = await configStorage.readConfig(
                capabilities,
                file
            );
            expect(readConfig).toEqual(initialConfig);

            // 3. Modify config using utility functions
            let modifiedConfig = configStorage.addShortcut(readConfig, {
                pattern: "new",
                replacement: "NEW",
                description: "Added shortcut",
            });

            modifiedConfig = configStorage.removeShortcut(
                modifiedConfig,
                "initial"
            );

            // 4. Write modified config
            await configStorage.writeConfig(
                capabilities,
                testFile,
                modifiedConfig
            );

            // 5. Read and verify final config
            const finalConfig = await configStorage.readConfig(
                capabilities,
                file
            );
            expect(finalConfig).toEqual({
                help: "Integration test config",
                shortcuts: [
                    {
                        pattern: "new",
                        replacement: "NEW",
                        description: "Added shortcut",
                    },
                ],
            });

            // 6. Verify utility functions work on final config
            const foundShortcut = configStorage.findShortcut(
                finalConfig,
                "new"
            );
            expect(foundShortcut).toEqual({
                pattern: "new",
                replacement: "NEW",
                description: "Added shortcut",
            });

            const notFound = configStorage.findShortcut(finalConfig, "initial");
            expect(notFound).toBeNull();
        });

        it("should handle complex shortcuts with special characters", async () => {
            const testFile = await getTestPath();
            const capabilities = getTestCapabilities();

            const complexConfig = {
                help: "Complex shortcuts with special characters",
                shortcuts: [
                    {
                        pattern: "\\d+",
                        replacement: "[NUMBER]",
                        description: "Regex for digits",
                    },
                    {
                        pattern: "@user",
                        replacement: "@username",
                        description: "User mention",
                    },
                    {
                        pattern: "emoji😀",
                        replacement: "😊",
                        description: "Emoji replacement",
                    },
                    {
                        pattern: "multi\nline",
                        replacement: "single line",
                        description: "Newline handling",
                    },
                    {
                        pattern: 'quotes"test',
                        replacement: "quotes'test",
                        description: "Quote handling",
                    },
                    { pattern: "", replacement: "empty pattern" }, // Edge case
                ],
            };

            await configStorage.writeConfig(
                capabilities,
                testFile,
                complexConfig                );

                const file = await checker.make().instantiate(testFile);
            const readConfig = await configStorage.readConfig(
                capabilities,
                file
            );

            expect(readConfig).toEqual(complexConfig);

            // Test specific pattern lookups
            expect(
                configStorage.findShortcut(readConfig, "\\d+")?.description
            ).toBe("Regex for digits");
            expect(
                configStorage.findShortcut(readConfig, "emoji😀")?.replacement
            ).toBe("😊");
            expect(
                configStorage.findShortcut(readConfig, "")?.replacement
            ).toBe("empty pattern");
        });
    });
});
