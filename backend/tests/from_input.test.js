const {
    makeInputParseError,
    isInputParseError,
    makeShortcutApplicationError,
    isShortcutApplicationError,
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
        expect(() => parseModifier("")).toThrow();
        expect(() => parseModifier("   ")).toThrow();
        let err;
        try {
            parseModifier("");
        } catch (e) {
            err = e;
        }
        expect(isInputParseError(err)).toBe(true);
    });

    test("error includes original input", () => {
        let error;
        try {
            parseModifier("invalid format here [brackets]");
        } catch (e) {
            error = e;
        }
        expect(isInputParseError(error)).toBe(true);
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
        expect(() => parseStructuredInput("")).toThrow();
        expect(() => parseStructuredInput("   ")).toThrow();
        expect(() => parseStructuredInput("[invalid] structure")).toThrow();
        expect(() => parseStructuredInput("123invalid")).toThrow();
        let err1;
        try {
            parseStructuredInput("");
        } catch (e) {
            err1 = e;
        }
        expect(isInputParseError(err1)).toBe(true);
    });

    test("throws InputParseError when type is missing", () => {
        expect(() => parseStructuredInput("[loc office] - no type")).toThrow();
        let err2;
        try {
            parseStructuredInput("[loc office] - no type");
        } catch (e) {
            err2 = e;
        }
        expect(isInputParseError(err2)).toBe(true);
    });

    test("error includes original input", () => {
        let error;
        try {
            parseStructuredInput("123invalid");
        } catch (e) {
            error = e;
        }
        expect(isInputParseError(error)).toBe(true);
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
            expect(() => parseStructuredInput(input)).toThrow();
            expect(() => parseStructuredInput(input)).toThrow(
                "Modifiers must appear immediately after the type, before any description text"
            );
            let errLoop;
            try {
                parseStructuredInput(input);
            } catch (e) {
                errLoop = e;
            }
            expect(isInputParseError(errLoop)).toBe(true);
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
                    {pattern: "\\bw\\b", replacement: "WORK"}
                ]
            });
        });

        const result = await applyShortcuts(capabilities, "w [loc office]");
        expect(result).toBe("WORK [loc office]");
    });

    test("applies multiple shortcuts", async () => {
        const capabilities = await getTestCapabilities();
        
        // Set up config through transaction system (proper way)
        const { transaction } = require("../src/event_log_storage");
        await transaction(capabilities, async (storage) => {
            storage.setConfig({
                help: "test config",
                shortcuts: [
                    {pattern: "\\bw\\b", replacement: "WORK"},
                    {pattern: "\\bh\\b", replacement: "HOME"}
                ]
            });
        });

        let result = await applyShortcuts(capabilities, "w [loc h]");
        expect(result).toBe("WORK [loc HOME]");
    });

    test("applies recursive shortcuts", async () => {
        const capabilities = await getTestCapabilities();
        
        // Set up config through transaction system (proper way)
        const { transaction } = require("../src/event_log_storage");
        await transaction(capabilities, async (storage) => {
            storage.setConfig({
                help: "test config",
                shortcuts: [
                    {pattern: "\\bw\\b", replacement: "WORK"},
                    {pattern: "\\bo\\b", replacement: "office"},
                    {pattern: "\\bwo\\b", replacement: "w [loc o]"}
                ]
            });
        });

        const result = await applyShortcuts(capabilities, "wo - Fixed bug");
        expect(result).toBe("WORK [loc office] - Fixed bug");
    });

    test("handles missing config file gracefully", async () => {
        const capabilities = await getTestCapabilities();
        // Don't create config file - it should handle this gracefully
        const result = await applyShortcuts(capabilities, "WORK [loc office]");
        expect(result).toBe("WORK [loc office]");
    });

    test("handles config without shortcuts property", async () => {
        const capabilities = await getTestCapabilities();
        
        // Set up config through transaction system (proper way)
        const { transaction } = require("../src/event_log_storage");
        await transaction(capabilities, async (storage) => {
            storage.setConfig({
                help: "config without any shortcuts",
                shortcuts: [] // Empty shortcuts array
            });
        });

        const result = await applyShortcuts(capabilities, "WORK [loc office]");
        expect(result).toBe("WORK [loc office]");
    });

    test("preserves input when no shortcuts match", async () => {
        const capabilities = await getTestCapabilities();
        
        // Set up config through transaction system (proper way)  
        const { transaction } = require("../src/event_log_storage");
        await transaction(capabilities, async (storage) => {
            storage.setConfig({
                help: "test config",
                shortcuts: [
                    {pattern: "\\bw\\b", replacement: "WORK"}
                ]
            });
        });

        const result = await applyShortcuts(capabilities, "EXERCISE [loc gym]");
        expect(result).toBe("EXERCISE [loc gym]");
    });

    test("applies word boundary matching", async () => {
        const capabilities = await getTestCapabilities();
        
        // Set up config through transaction system (proper way)
        const { transaction } = require("../src/event_log_storage");
        await transaction(capabilities, async (storage) => {
            storage.setConfig({
                help: "test config",
                shortcuts: [
                    {pattern: "\\bw\\b", replacement: "WORK"}
                ]
            });
        });

        // Should not replace 'w' inside 'working'
        const result = await applyShortcuts(capabilities, "working on project");
        expect(result).toBe("working on project");
    });
});

describe("processUserInput", () => {
    test("processes complete pipeline without shortcuts", async () => {
        const capabilities = await getTestCapabilities();
        
        // Set up config through transaction system (proper way)
        const { transaction } = require("../src/event_log_storage");
        await transaction(capabilities, async (storage) => {
            storage.setConfig({
                help: "test config",
                shortcuts: []
            });
        });

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
        const capabilities = await getTestCapabilities();
        
        // Set up config through transaction system (proper way)
        const { transaction } = require("../src/event_log_storage");
        await transaction(capabilities, async (storage) => {
            storage.setConfig({
                help: "test config",
                shortcuts: [
                    {pattern: "\\bw\\b", replacement: "WORK"},
                    {pattern: "\\bo\\b", replacement: "office"}
                ]
            });
        });

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
        const capabilities = await getTestCapabilities();
        
        // Set up config through transaction system (proper way)
        const { transaction } = require("../src/event_log_storage");
        await transaction(capabilities, async (storage) => {
            storage.setConfig({
                help: "test config",
                shortcuts: []
            });
        });

        const result = await processUserInput(capabilities, "  \t\n  WORK  \t\n  ");

        expect(result.original).toBe("  \t\n  WORK  \t\n  ");
        expect(result.input).toBe("WORK");
        expect(result.parsed.type).toBe("WORK");
    });

    test("propagates parsing errors", async () => {
        const capabilities = await getTestCapabilities();
        
        // Set up config through transaction system (proper way)
        const { transaction } = require("../src/event_log_storage");
        await transaction(capabilities, async (storage) => {
            storage.setConfig({
                help: "test config",
                shortcuts: []
            });
        });

        await expect(processUserInput(capabilities, "[invalid] format"))
            .rejects.toThrow();
        let errProc;
        try {
            await processUserInput(capabilities, "[invalid] format");
        } catch (e) {
            errProc = e;
        }
        expect(isInputParseError(errProc)).toBe(true);
    });

    test("handles minimal input", async () => {
        const capabilities = await getTestCapabilities();
        
        // Set up config through transaction system (proper way)
        const { transaction } = require("../src/event_log_storage");
        await transaction(capabilities, async (storage) => {
            storage.setConfig({
                help: "test config",
                shortcuts: []
            });
        });

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
        const error = makeInputParseError("Test message", "test input");
        expect(error.message).toBe("Test message");
        expect(error.input).toBe("test input");
        expect(error).toBeInstanceOf(Error);
        expect(isInputParseError(error)).toBe(true);
    });

    test("ShortcutApplicationError stores input and message", () => {
        const error = makeShortcutApplicationError("Test message", "test input", "pattern");
        expect(error.message).toBe("Test message");
        expect(error.input).toBe("test input");
        expect(error).toBeInstanceOf(Error);
        expect(isShortcutApplicationError(error)).toBe(true);
    });
});

describe("Integration Tests", () => {
    test("complex workflow with multiple shortcuts and modifiers", async () => {
        const capabilities = await getTestCapabilities();
        
        // Set up config through transaction system (proper way)
        const { transaction } = require("../src/event_log_storage");
        await transaction(capabilities, async (storage) => {
            storage.setConfig({
                help: "test config",
                shortcuts: [
                    {pattern: "\\bw\\b", replacement: "WORK"},
                    {pattern: "\\bs\\b", replacement: "SOCIAL"},
                    {pattern: "\\bo\\b", replacement: "office"},
                    {pattern: "\\bh\\b", replacement: "home"},
                    {pattern: "\\bj\\b", replacement: "John"},
                    {pattern: "\\bm\\b", replacement: "Mary"},
                    {pattern: "\\bquick\\b", replacement: "w [loc o] [with j]"}
                ]
            });
        });

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
        const capabilities = await getTestCapabilities();
        
        // Set up config through transaction system (proper way)
        const { transaction } = require("../src/event_log_storage");
        await transaction(capabilities, async (storage) => {
            storage.setConfig({
                help: "test config",
                shortcuts: [
                    {pattern: "\\bbad\\b", replacement: "[invalid structure"}
                ]
            });
        });

        await expect(processUserInput(capabilities, "bad"))
            .rejects.toThrow();
        let errEdge;
        try {
            await processUserInput(capabilities, "bad");
        } catch (e) {
            errEdge = e;
        }
        expect(isInputParseError(errEdge)).toBe(true);
    });

    test("preserves complex descriptions", async () => {
        const capabilities = await getTestCapabilities();
        
        // Set up config through transaction system (proper way)
        const { transaction } = require("../src/event_log_storage");
        await transaction(capabilities, async (storage) => {
            storage.setConfig({
                help: "test config",
                shortcuts: []
            });
        });

        const complexDescription = "Implemented new feature with \\[brackets\\] and special chars: @#$%";
        const result = await processUserInput(capabilities, `work - ${complexDescription}`);

        expect(result.parsed.description).toBe(`- ${complexDescription}`);
    });
});
