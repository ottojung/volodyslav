const config = require("../src/config");
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
                const result = config.tryDeserialize(obj);
                expect(config.isTryDeserializeError(result)).toBe(true);
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
                const result = config.tryDeserialize(obj);
                expect(config.isTryDeserializeError(result)).toBe(true);
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

