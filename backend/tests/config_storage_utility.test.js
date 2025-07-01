const configStorage = require("../src/config/storage");

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

});
