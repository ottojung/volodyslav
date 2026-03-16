const { parseStructuredInput, isInputParseError } = require("../src/event/from_input");

describe("parseStructuredInput", () => {
    // -------------------------------------------------------------------------
    // Basic valid inputs
    // -------------------------------------------------------------------------

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

    test("parses type with key-value modifier", () => {
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

    // -------------------------------------------------------------------------
    // Flag modifiers (no value) must come before description
    // -------------------------------------------------------------------------

    test("parses flag modifier [key] before description", () => {
        const result = parseStructuredInput("WORK [done] task number 1");
        expect(result).toEqual({
            type: "WORK",
            description: "task number 1",
            modifiers: { done: "" }
        });
    });

    test("parses flag modifier [key] with no description", () => {
        const result = parseStructuredInput("WORK [done]");
        expect(result).toEqual({
            type: "WORK",
            description: "",
            modifiers: { done: "" }
        });
    });

    test("parses multiple flag modifiers before description", () => {
        const result = parseStructuredInput("TASK [urgent] [done] some notes");
        expect(result).toEqual({
            type: "TASK",
            description: "some notes",
            modifiers: { urgent: "", done: "" }
        });
    });

    test("parses mixed flag and key-value modifiers before description", () => {
        const result = parseStructuredInput("WORK [done] [loc office] final report");
        expect(result).toEqual({
            type: "WORK",
            description: "final report",
            modifiers: { done: "", loc: "office" }
        });
    });

    test("parses flag modifier alongside key-value modifier, no description", () => {
        const result = parseStructuredInput("WORK [done] [loc office]");
        expect(result).toEqual({
            type: "WORK",
            description: "",
            modifiers: { done: "", loc: "office" }
        });
    });

    // -------------------------------------------------------------------------
    // Throws when any modifier appears in description
    // -------------------------------------------------------------------------

    test("throws InputParseError for bad structure", () => {
        expect(() => parseStructuredInput("[invalid] format")).toThrow();
        let err;
        try {
            parseStructuredInput("[invalid] format");
        } catch (e) {
            err = e;
        }
        expect(isInputParseError(err)).toBe(true);
    });

    test("throws when key-value modifier [key value] appears after description text", () => {
        expect(() => parseStructuredInput("WORK description [loc office]")).toThrow();
        let err;
        try {
            parseStructuredInput("WORK description [loc office]");
        } catch (e) {
            err = e;
        }
        expect(isInputParseError(err)).toBe(true);
    });

    test("throws when flag modifier [key] appears after description text", () => {
        expect(() => parseStructuredInput("WORK task number 1 [done]")).toThrow();
        let err;
        try {
            parseStructuredInput("WORK task number 1 [done]");
        } catch (e) {
            err = e;
        }
        expect(isInputParseError(err)).toBe(true);
    });

    test("throws when flag modifier appears mid-description", () => {
        expect(() => parseStructuredInput("WORK some text [flag] more text")).toThrow();
        let err;
        try {
            parseStructuredInput("WORK some text [flag] more text");
        } catch (e) {
            err = e;
        }
        expect(isInputParseError(err)).toBe(true);
    });

    test("throws when key-value modifier appears mid-description", () => {
        expect(() => parseStructuredInput("WORK some text [loc office] more text")).toThrow();
        let err;
        try {
            parseStructuredInput("WORK some text [loc office] more text");
        } catch (e) {
            err = e;
        }
        expect(isInputParseError(err)).toBe(true);
    });

    test("throws when valid modifiers are followed by description containing a modifier", () => {
        expect(() => parseStructuredInput("WORK [done] description [loc office]")).toThrow();
        let err;
        try {
            parseStructuredInput("WORK [done] description [loc office]");
        } catch (e) {
            err = e;
        }
        expect(isInputParseError(err)).toBe(true);
    });

    test("throws for multiple flag modifiers after description", () => {
        expect(() => parseStructuredInput("TASK some notes [flag1] [flag2]")).toThrow();
        let err;
        try {
            parseStructuredInput("TASK some notes [flag1] [flag2]");
        } catch (e) {
            err = e;
        }
        expect(isInputParseError(err)).toBe(true);
    });

    // -------------------------------------------------------------------------
    // Non-modifier brackets in description are allowed
    // -------------------------------------------------------------------------

    test("allows unclosed bracket in description", () => {
        const result = parseStructuredInput("work [unclosed bracket in description");
        expect(result.description).toBe("[unclosed bracket in description");
        expect(result.modifiers).toEqual({});
    });

    test("allows numeric bracket [123] in description", () => {
        // Brackets starting with a digit are not modifiers
        const result = parseStructuredInput("note [123] numbers in brackets");
        expect(result).toEqual({
            type: "note",
            description: "[123] numbers in brackets",
            modifiers: {}
        });
    });

    test("allows standalone closing bracket in description", () => {
        const result = parseStructuredInput("item description with ] standalone bracket");
        expect(result).toEqual({
            type: "item",
            description: "description with ] standalone bracket",
            modifiers: {}
        });
    });
});
