const fs = require("fs").promises;
const path = require("path");
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
            const file = await capabilities.checker.instantiate(testFile);
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

                const file = await capabilities.checker.instantiate(testFile);
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
