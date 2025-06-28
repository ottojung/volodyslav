const fs = require("fs").promises;
const path = require("path");
const {
    InputParseError,
    ShortcutApplicationError,
    normalizeInput,
    parseModifier,
    parseStructuredInput,
    applyShortcuts,
    processUserInput
} = require("../src/event/from_input");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime } = require("./stubs");
const { stubEventLogRepository } = require("./stub_event_log_repository");

async function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    await stubEventLogRepository(capabilities);
    return capabilities;
}

describe("normalizeInput", () => {
    test("trims whitespace", () => {
        expect(normalizeInput("  WORK  ")).toBe("WORK");
        expect(normalizeInput("\t\nWORK [loc office]\n\t")).toBe("WORK [loc office]");
        expect(normalizeInput("  work  ")).toBe("work");
        expect(normalizeInput("\t\nwork [loc office]\n\t")).toBe("work [loc office]");
    });

    test("handles empty input", () => {
        expect(normalizeInput("")).toBe("");
        expect(normalizeInput("   ")).toBe("");
    });

    test("preserves internal structure", () => {
        const input = "work [loc office] - Fixed the parser bug";
        expect(normalizeInput(input)).toBe(input);
    });
});

describe("parseModifier", () => {
    test("parses simple modifier", () => {
        const result = parseModifier("loc office");
        expect(result).toEqual({
            type: "loc",
            description: "office"
        });
    });

    test("parses modifier with multiple words in description", () => {
        const result = parseModifier("with John Doe");
        expect(result).toEqual({
            type: "with",
            description: "John Doe"
        });
    });

    test("handles numeric values", () => {
        const result = parseModifier("amount 50.5");
        expect(result).toEqual({
            type: "amount",
            description: "50.5"
        });
    });

    test("handles empty description", () => {
        const result = parseModifier("flag");
        expect(result).toEqual({
            type: "flag",
            description: ""
        });
    });

    test("throws InputParseError for invalid format", () => {
        expect(() => parseModifier("")).toThrow(InputParseError);
        expect(() => parseModifier("   ")).toThrow(InputParseError);
    });

    test("error includes original input", () => {
        let error;
        try {
            parseModifier("invalid format here [brackets]");
        } catch (e) {
            error = e;
        }
        expect(error).toBeInstanceOf(InputParseError);
        expect(error.input).toBe("invalid format here [brackets]");
        expect(error.message).toContain("Not a valid modifier");
    });
});

describe("parseStructuredInput", () => {
    test("parses minimal input (type only)", () => {
        const result = parseStructuredInput("WORK");
        expect(result).toEqual({
            type: "WORK",
            description: "",
            modifiers: {}
        });
    });

    test("parses type with description", () => {
        const result = parseStructuredInput("MEAL - Had breakfast");
        expect(result).toEqual({
            type: "MEAL",
            description: "- Had breakfast",
            modifiers: {}
        });
    });

    test("parses type with single modifier", () => {
        const result = parseStructuredInput("WORK [loc office]");
        expect(result).toEqual({
            type: "WORK",
            description: "",
            modifiers: {
                loc: "office"
            }
        });
    });

    test("parses type with modifier and description", () => {
        const result = parseStructuredInput("EXERCISE [loc gym] - Weightlifting session");
        expect(result).toEqual({
            type: "EXERCISE",
            description: "- Weightlifting session",
            modifiers: {
                loc: "gym"
            }
        });
    });

    test("parses multiple modifiers", () => {
        const result = parseStructuredInput("SOCIAL [with John] [loc cafe] - Coffee meeting");
        expect(result).toEqual({
            type: "SOCIAL",
            description: "- Coffee meeting",
            modifiers: {
                with: "John",
                loc: "cafe"
            }
        });
    });

    test("handles whitespace variations", () => {
        const result = parseStructuredInput("  WORK   [loc  office]   -   Fixed  bug  ");
        expect(result).toEqual({
            type: "WORK",
            description: "-   Fixed  bug",
            modifiers: {
                loc: "office"
            }
        });
    });

    test("parses multi-word description without modifiers", () => {
        const result = parseStructuredInput("work Fixed the parser bug");
        expect(result).toEqual({
            type: "work",
            description: "Fixed the parser bug",
            modifiers: {}
        });
    });

    test("throws InputParseError for invalid structure", () => {
        expect(() => parseStructuredInput("")).toThrow(InputParseError);
        expect(() => parseStructuredInput("   ")).toThrow(InputParseError);
        expect(() => parseStructuredInput("[invalid] structure")).toThrow(InputParseError);
        expect(() => parseStructuredInput("123invalid")).toThrow(InputParseError);
    });

    test("throws InputParseError when type is missing", () => {
        expect(() => parseStructuredInput("[loc office] - no type")).toThrow(InputParseError);
    });

    test("error includes original input", () => {
        let error;
        try {
            parseStructuredInput("123invalid");
        } catch (e) {
            error = e;
        }
        expect(error).toBeInstanceOf(InputParseError);
        expect(error.input).toBe("123invalid");
    });

    test("rejects modifier patterns in description", () => {
        // Test cases that should be rejected
        const invalidInputs = [
            "food [mod1 val1] this is where description starts [unexpected modifier]",
            "work [loc office] description with [another modifier] here",
            "task [priority high] some text [status done]",
            "meeting [with John] notes [duration 2h]"
        ];

        for (const input of invalidInputs) {
            expect(() => parseStructuredInput(input)).toThrow(InputParseError);
            expect(() => parseStructuredInput(input)).toThrow("Modifiers must appear immediately after the type, before any description text");
        }
    });

    test("allows brackets in descriptions that don't look like modifiers", () => {
        // Test cases that should be valid (brackets without modifier pattern)
        const validInputs = [
            { input: "work [unclosed bracket in description", expectedDesc: "[unclosed bracket in description" },
            { input: "task description with [brackets] but no spaces", expectedDesc: "description with [brackets] but no spaces" },
            { input: "note [123] numbers in brackets", expectedDesc: "[123] numbers in brackets" },
            { input: "item description with ] standalone bracket", expectedDesc: "description with ] standalone bracket" }
        ];

        for (const testCase of validInputs) {
            expect(() => parseStructuredInput(testCase.input)).not.toThrow();
            const result = parseStructuredInput(testCase.input);
            expect(result.description).toBe(testCase.expectedDesc);
        }
    });
});

describe("applyShortcuts", () => {
    test("applies no shortcuts when config is empty", async () => {
        const capabilities = await getTestCapabilities();
        
        // Set up config through transaction system (proper way)
        const { transaction } = require("../src/event_log_storage");
        await transaction(capabilities, async (storage) => {
            storage.setConfig({
                help: "test config",
                shortcuts: []
            });
        });

        const result = await applyShortcuts(capabilities, "WORK [loc office]");
        expect(result).toBe("WORK [loc office]");
    });

    test("applies simple shortcut", async () => {
        const capabilities = await getTestCapabilities();
        
        // Set up config through transaction system (proper way)
        const { transaction } = require("../src/event_log_storage");
        await transaction(capabilities, async (storage) => {
            storage.setConfig({
                help: "test config",
                shortcuts: [
                    ["\\bw\\b", "WORK"]
                ]
            });
        });

        const result = await applyShortcuts(capabilities, "w [loc office]");
        expect(result).toBe("WORK [loc office]");
    });

    test("applies multiple shortcuts", async () => {
        const capabilities = getTestCapabilities();
        const configPath = capabilities.environment.eventLogRepository() + "/config.json";
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(configPath, JSON.stringify({
            help: "test config",
            shortcuts: [
                ["\\bw\\b", "WORK"],
                ["\\bh\\b", "HOME"]
            ]
        }));

        let result = await applyShortcuts(capabilities, "w [loc h]");
        expect(result).toBe("WORK [loc HOME]");
    });

    test("applies recursive shortcuts", async () => {
        const capabilities = getTestCapabilities();
        const configPath = capabilities.environment.eventLogRepository() + "/config.json";
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(configPath, JSON.stringify({
            help: "test config",
            shortcuts: [
                ["\\bw\\b", "WORK"],
                ["\\bo\\b", "office"],
                ["\\bwo\\b", "w [loc o]"]
            ]
        }));

        const result = await applyShortcuts(capabilities, "wo - Fixed bug");
        expect(result).toBe("WORK [loc office] - Fixed bug");
    });

    test("handles missing config file gracefully", async () => {
        const capabilities = getTestCapabilities();
        // Don't create config file - it should handle this gracefully
        const result = await applyShortcuts(capabilities, "WORK [loc office]");
        expect(result).toBe("WORK [loc office]");
    });

    test("handles malformed config file", async () => {
        const capabilities = getTestCapabilities();
        const configPath = capabilities.environment.eventLogRepository() + "/config.json";
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(configPath, "invalid json");

        const result = await applyShortcuts(capabilities, "WORK [loc office]");
        expect(result).toBe("WORK [loc office]");
    });

    test("handles config without shortcuts property", async () => {
        const capabilities = getTestCapabilities();
        const configPath = capabilities.environment.eventLogRepository() + "/config.json";
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(configPath, JSON.stringify({
            help: "config without shortcuts",
            other: "config"
        }));

        const result = await applyShortcuts(capabilities, "WORK [loc office]");
        expect(result).toBe("WORK [loc office]");
    });

    test("preserves input when no shortcuts match", async () => {
        const capabilities = getTestCapabilities();
        const configPath = capabilities.environment.eventLogRepository() + "/config.json";
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(configPath, JSON.stringify({
            help: "test config",
            shortcuts: [
                ["\\bw\\b", "WORK"]
            ]
        }));

        const result = await applyShortcuts(capabilities, "EXERCISE [loc gym]");
        expect(result).toBe("EXERCISE [loc gym]");
    });

    test("applies word boundary matching", async () => {
        const capabilities = getTestCapabilities();
        const configPath = capabilities.environment.eventLogRepository() + "/config.json";
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(configPath, JSON.stringify({
            help: "test config",
            shortcuts: [
                ["\\bw\\b", "WORK"]
            ]
        }));

        // Should not replace 'w' inside 'working'
        const result = await applyShortcuts(capabilities, "working on project");
        expect(result).toBe("working on project");
    });
});

describe("processUserInput", () => {
    let capabilities;

    beforeEach(() => {
        capabilities = getTestCapabilities();
    });

    test("processes complete pipeline without shortcuts", async () => {
        const configPath = capabilities.environment.eventLogRepository() + "/config.json";
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(configPath, JSON.stringify({
            help: "test config",
            shortcuts: []
        }));

        const result = await processUserInput(capabilities, "WORK [loc office] - Fixed bug");

        expect(result).toEqual({
            original: "WORK [loc office] - Fixed bug",
            input: "WORK [loc office] - Fixed bug",
            parsed: {
                type: "WORK",
                description: "- Fixed bug",
                modifiers: {
                    loc: "office"
                }
            }
        });
    });

    test("processes complete pipeline with shortcuts", async () => {
        const configPath = capabilities.environment.eventLogRepository() + "/config.json";
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(configPath, JSON.stringify({
            help: "test config",
            shortcuts: [
                ["\\bw\\b", "WORK"],
                ["\\bo\\b", "office"]
            ]
        }));

        const result = await processUserInput(capabilities, "  w [loc o] - Fixed bug  ");

        expect(result).toEqual({
            original: "  w [loc o] - Fixed bug  ",
            input: "WORK [loc office] - Fixed bug",
            parsed: {
                type: "WORK",
                description: "- Fixed bug",
                modifiers: {
                    loc: "office"
                }
            }
        });
    });

    test("handles whitespace normalization", async () => {
        const configPath = capabilities.environment.eventLogRepository() + "/config.json";
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(configPath, JSON.stringify({
            help: "test config",
            shortcuts: []
        }));

        const result = await processUserInput(capabilities, "  \t\n  WORK  \t\n  ");

        expect(result.original).toBe("  \t\n  WORK  \t\n  ");
        expect(result.input).toBe("WORK");
        expect(result.parsed.type).toBe("WORK");
    });

    test("propagates parsing errors", async () => {
        const configPath = capabilities.environment.eventLogRepository() + "/config.json";
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(configPath, JSON.stringify({
            help: "test config",
            shortcuts: []
        }));

        await expect(processUserInput(capabilities, "[invalid] format"))
            .rejects.toThrow(InputParseError);
    });

    test("handles minimal input", async () => {
        const configPath = capabilities.environment.eventLogRepository() + "/config.json";
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(configPath, JSON.stringify({
            help: "test config",
            shortcuts: []
        }));

        const result = await processUserInput(capabilities, "WORK");

        expect(result.parsed).toEqual({
            type: "WORK",
            description: "",
            modifiers: {}
        });
    });
});

describe("Error Classes", () => {
    test("InputParseError stores input and message", () => {
        const error = new InputParseError("Test message", "test input");
        expect(error.message).toBe("Test message");
        expect(error.input).toBe("test input");
        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe("InputParseError");
    });

    test("ShortcutApplicationError stores input and message", () => {
        const error = new ShortcutApplicationError("Test message", "test input");
        expect(error.message).toBe("Test message");
        expect(error.input).toBe("test input");
        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe("ShortcutApplicationError");
    });
});

describe("Integration Tests", () => {
    test("complex workflow with multiple shortcuts and modifiers", async () => {
        const capabilities = getTestCapabilities();
        const configPath = capabilities.environment.eventLogRepository() + "/config.json";
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(configPath, JSON.stringify({
            help: "test config",
            shortcuts: [
                ["\\bw\\b", "WORK"],
                ["\\bs\\b", "SOCIAL"],
                ["\\bo\\b", "office"],
                ["\\bh\\b", "home"],
                ["\\bj\\b", "John"],
                ["\\bm\\b", "Mary"],
                ["\\bquick\\b", "w [loc o] [with j]"]
            ]
        }));

        const result = await processUserInput(capabilities, "quick - Daily standup meeting");

        expect(result.parsed).toEqual({
            type: "WORK",
            description: "- Daily standup meeting",
            modifiers: {
                loc: "office",
                with: "John"
            }
        });
    });

    test("edge case: shortcut creates invalid structure", async () => {
        const capabilities = getTestCapabilities();
        const configPath = capabilities.environment.eventLogRepository() + "/config.json";
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(configPath, JSON.stringify({
            help: "test config",
            shortcuts: [
                ["\\bbad\\b", "[invalid structure"]
            ]
        }));

        await expect(processUserInput(capabilities, "bad"))
            .rejects.toThrow(InputParseError);
    });

    test("preserves complex descriptions", async () => {
        const capabilities = getTestCapabilities();
        const configPath = capabilities.environment.eventLogRepository() + "/config.json";
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(configPath, JSON.stringify({
            help: "test config",
            shortcuts: []
        }));

        const complexDescription = "Implemented new feature with \\[brackets\\] and special chars: @#$%";
        const result = await processUserInput(capabilities, `work - ${complexDescription}`);

        expect(result.parsed.description).toBe(`- ${complexDescription}`);
    });
});
