const { parseStructuredInput, isInputParseError } = require("../src/event/from_input");

describe("parseStructuredInput", () => {
    // -------------------------------------------------------------------------
    // Basic structure
    // -------------------------------------------------------------------------

    test("parses minimal input (type only)", () => {
        const result = parseStructuredInput("WORK");
        expect(result).toEqual({
            type: "WORK",
            description: "",
            modifiers: {}
        });
    });

    test("parses lowercase type", () => {
        const result = parseStructuredInput("diary");
        expect(result).toEqual({
            type: "diary",
            description: "",
            modifiers: {}
        });
    });

    test("parses mixed-case type", () => {
        const result = parseStructuredInput("AudioNote");
        expect(result).toEqual({
            type: "AudioNote",
            description: "",
            modifiers: {}
        });
    });

    test("parses type that contains digits", () => {
        const result = parseStructuredInput("NOTE2");
        expect(result).toEqual({
            type: "NOTE2",
            description: "",
            modifiers: {}
        });
    });

    test("parses type with leading/trailing whitespace", () => {
        const result = parseStructuredInput("  WORK  ");
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

    test("parses type with multi-word description", () => {
        const result = parseStructuredInput("NOTE lots of words in the description here");
        expect(result).toEqual({
            type: "NOTE",
            description: "lots of words in the description here",
            modifiers: {}
        });
    });

    // -------------------------------------------------------------------------
    // Key-value modifiers
    // -------------------------------------------------------------------------

    test("parses type with a single key-value modifier", () => {
        const result = parseStructuredInput("WORK [loc office]");
        expect(result).toEqual({
            type: "WORK",
            description: "",
            modifiers: { loc: "office" }
        });
    });

    test("parses type with multiple key-value modifiers", () => {
        const result = parseStructuredInput("SOCIAL [with John] [loc cafe]");
        expect(result).toEqual({
            type: "SOCIAL",
            description: "",
            modifiers: {
                with: "John",
                loc: "cafe"
            }
        });
    });

    test("parses modifier with multi-word value", () => {
        const result = parseStructuredInput("EVENT [when 0 hours ago]");
        expect(result).toEqual({
            type: "EVENT",
            description: "",
            modifiers: { when: "0 hours ago" }
        });
    });

    test("parses type with key-value modifier and description", () => {
        const result = parseStructuredInput("WORK [loc office] - Fixed the parser bug");
        expect(result).toEqual({
            type: "WORK",
            description: "- Fixed the parser bug",
            modifiers: {
                loc: "office"
            }
        });
    });

    test("parses modifier with mixed-case key", () => {
        const result = parseStructuredInput("WORK [locHome here]");
        expect(result).toEqual({
            type: "WORK",
            description: "",
            modifiers: { locHome: "here" }
        });
    });

    test("parses modifier key with underscores and digits", () => {
        const result = parseStructuredInput("TASK [key_name_1 value]");
        expect(result).toEqual({
            type: "TASK",
            description: "",
            modifiers: { key_name_1: "value" }
        });
    });

    // -------------------------------------------------------------------------
    // Flag modifiers (single-word brackets, no value)
    // -------------------------------------------------------------------------

    test("parses a single flag modifier", () => {
        const result = parseStructuredInput("TASK [done]");
        expect(result).toEqual({
            type: "TASK",
            description: "",
            modifiers: { done: "" }
        });
    });

    test("parses multiple flag modifiers", () => {
        const result = parseStructuredInput("TASK [done] [archived] [urgent]");
        expect(result).toEqual({
            type: "TASK",
            description: "",
            modifiers: { done: "", archived: "", urgent: "" }
        });
    });

    test("parses flag modifiers mixed with key-value modifiers (regression)", () => {
        // Regression: [audiorecording] used to end up in description
        const result = parseStructuredInput("diary [when 0 hours ago] [audiorecording]");
        expect(result).toEqual({
            type: "diary",
            description: "",
            modifiers: {
                when: "0 hours ago",
                audiorecording: ""
            }
        });
    });

    test("parses flag modifier before key-value modifier", () => {
        const result = parseStructuredInput("WORK [done] [loc office]");
        expect(result).toEqual({
            type: "WORK",
            description: "",
            modifiers: { done: "", loc: "office" }
        });
    });

    test("parses flag modifier followed by description", () => {
        const result = parseStructuredInput("WORK [loc office] [done] some notes");
        expect(result).toEqual({
            type: "WORK",
            description: "some notes",
            modifiers: { loc: "office", done: "" }
        });
    });

    test("flag modifier with underscore key is treated as a modifier", () => {
        const result = parseStructuredInput("WORK [flag_with_underscore]");
        expect(result).toEqual({
            type: "WORK",
            description: "",
            modifiers: { flag_with_underscore: "" }
        });
    });

    // -------------------------------------------------------------------------
    // Brackets that stay in the description
    // -------------------------------------------------------------------------

    test("bracket starting with a digit stays in description", () => {
        const result = parseStructuredInput("note [123] numbers in brackets");
        expect(result).toEqual({
            type: "note",
            description: "[123] numbers in brackets",
            modifiers: {}
        });
    });

    test("bracket starting with underscore stays in description", () => {
        const result = parseStructuredInput("TASK [_flag]");
        expect(result).toEqual({
            type: "TASK",
            description: "[_flag]",
            modifiers: {}
        });
    });

    test("unclosed bracket stays in description", () => {
        const result = parseStructuredInput("work [unclosed bracket in description");
        expect(result).toEqual({
            type: "work",
            description: "[unclosed bracket in description",
            modifiers: {}
        });
    });

    test("standalone closing bracket stays in description", () => {
        const result = parseStructuredInput("item description with ] standalone bracket");
        expect(result).toEqual({
            type: "item",
            description: "description with ] standalone bracket",
            modifiers: {}
        });
    });

    test("bracket without spaces in description is left in description", () => {
        const result = parseStructuredInput("task description with [brackets] but no spaces");
        expect(result).toEqual({
            type: "task",
            description: "description with [brackets] but no spaces",
            modifiers: {}
        });
    });

    // -------------------------------------------------------------------------
    // Flag modifier after description text — stays in description, no throw
    // -------------------------------------------------------------------------

    test("flag modifier [key] after description text stays in description (not an error)", () => {
        // Because [key] (no space) is ambiguous as a modifier vs. description text,
        // only key-value modifiers after description text are rejected.
        const result = parseStructuredInput("WORK description [done]");
        expect(result).toEqual({
            type: "WORK",
            description: "description [done]",
            modifiers: {}
        });
    });

    test("multiple letter-only brackets after description text all stay in description", () => {
        const result = parseStructuredInput("TASK some notes [flag1] [flag2]");
        expect(result).toEqual({
            type: "TASK",
            description: "some notes [flag1] [flag2]",
            modifiers: {}
        });
    });

    // -------------------------------------------------------------------------
    // Key-value modifier after description text — throws
    // -------------------------------------------------------------------------

    test("throws InputParseError when key-value modifier appears after description", () => {
        let err;
        try {
            parseStructuredInput("WORK description [loc office]");
        } catch (e) {
            err = e;
        }
        expect(isInputParseError(err)).toBe(true);
    });

    test("throws InputParseError when key-value modifier appears after flag in description", () => {
        let err;
        try {
            parseStructuredInput("TASK some notes [done flag] extra");
        } catch (e) {
            err = e;
        }
        expect(isInputParseError(err)).toBe(true);
    });

    // -------------------------------------------------------------------------
    // Structural errors
    // -------------------------------------------------------------------------

    test("throws InputParseError for bad structure (no type)", () => {
        let err;
        try {
            parseStructuredInput("[invalid] format");
        } catch (e) {
            err = e;
        }
        expect(isInputParseError(err)).toBe(true);
    });

    test("throws InputParseError for input starting with a digit", () => {
        let err;
        try {
            parseStructuredInput("123 task");
        } catch (e) {
            err = e;
        }
        expect(isInputParseError(err)).toBe(true);
    });

    test("throws InputParseError for input starting with a special character", () => {
        let err;
        try {
            parseStructuredInput("- task");
        } catch (e) {
            err = e;
        }
        expect(isInputParseError(err)).toBe(true);
    });

    // -------------------------------------------------------------------------
    // Whitespace handling
    // -------------------------------------------------------------------------

    test("handles extra whitespace between type and modifier", () => {
        const result = parseStructuredInput("WORK  [key]  description");
        expect(result).toEqual({
            type: "WORK",
            description: "description",
            modifiers: { key: "" }
        });
    });

    test("handles extra whitespace between modifiers", () => {
        const result = parseStructuredInput("SOCIAL  [with John]   [loc cafe]  notes");
        expect(result).toEqual({
            type: "SOCIAL",
            description: "notes",
            modifiers: { with: "John", loc: "cafe" }
        });
    });
});
