import { getEntryParsed } from "../src/DescriptionEntry/entry.js";

/**
 * Helper to call parseInput via getEntryParsed.
 * @param {string} input
 */
function parseInput(input) {
    return getEntryParsed({ input });
}

describe("parseInput (frontend entry parsing)", () => {
    // -------------------------------------------------------------------------
    // Basic structure
    // -------------------------------------------------------------------------

    test("parses minimal input (type only)", () => {
        expect(parseInput("WORK")).toEqual({
            type: "WORK",
            description: "",
            modifiers: {},
        });
    });

    test("parses lowercase type", () => {
        expect(parseInput("diary")).toEqual({
            type: "diary",
            description: "",
            modifiers: {},
        });
    });

    test("parses mixed-case type", () => {
        expect(parseInput("AudioNote")).toEqual({
            type: "AudioNote",
            description: "",
            modifiers: {},
        });
    });

    test("parses type that contains digits", () => {
        expect(parseInput("NOTE2")).toEqual({
            type: "NOTE2",
            description: "",
            modifiers: {},
        });
    });

    test("returns empty type when input is empty", () => {
        const result = parseInput("");
        expect(result.type).toBe("");
        expect(result.description).toBe("");
        expect(result.modifiers).toEqual({});
    });

    test("returns empty type for whitespace-only input", () => {
        const result = parseInput("   ");
        expect(result.type).toBe("");
    });

    test("parses type with leading/trailing whitespace", () => {
        const result = parseInput("  WORK  ");
        expect(result.type).toBe("WORK");
    });

    test("parses type with description", () => {
        expect(parseInput("MEAL - Had breakfast")).toEqual({
            type: "MEAL",
            description: "- Had breakfast",
            modifiers: {},
        });
    });

    test("parses type with multi-word description", () => {
        expect(parseInput("NOTE lots of words in the description here")).toEqual({
            type: "NOTE",
            description: "lots of words in the description here",
            modifiers: {},
        });
    });

    // -------------------------------------------------------------------------
    // Key-value modifiers
    // -------------------------------------------------------------------------

    test("parses type with a single key-value modifier", () => {
        expect(parseInput("WORK [loc office]")).toEqual({
            type: "WORK",
            description: "",
            modifiers: { loc: "office" },
        });
    });

    test("parses type with multiple key-value modifiers", () => {
        expect(parseInput("SOCIAL [with John] [loc cafe]")).toEqual({
            type: "SOCIAL",
            description: "",
            modifiers: {
                with: "John",
                loc: "cafe",
            },
        });
    });

    test("parses modifier with multi-word value", () => {
        expect(parseInput("EVENT [when 0 hours ago]")).toEqual({
            type: "EVENT",
            description: "",
            modifiers: { when: "0 hours ago" },
        });
    });

    test("parses type with key-value modifier and description", () => {
        expect(parseInput("WORK [loc office] - Fixed the parser bug")).toEqual({
            type: "WORK",
            description: "- Fixed the parser bug",
            modifiers: {
                loc: "office",
            },
        });
    });

    // -------------------------------------------------------------------------
    // Flag modifiers (single-word brackets, no value)
    // -------------------------------------------------------------------------

    test("parses a single flag modifier", () => {
        expect(parseInput("TASK [done]")).toEqual({
            type: "TASK",
            description: "",
            modifiers: {
                done: "",
            },
        });
    });

    test("parses multiple flag modifiers", () => {
        expect(parseInput("TASK [done] [archived] [urgent]")).toEqual({
            type: "TASK",
            description: "",
            modifiers: { done: "", archived: "", urgent: "" },
        });
    });

    test("parses flag modifiers mixed with key-value modifiers (regression)", () => {
        // Regression: [audiorecording] used to end up in description
        expect(parseInput("diary [when 0 hours ago] [audiorecording]")).toEqual({
            type: "diary",
            description: "",
            modifiers: {
                when: "0 hours ago",
                audiorecording: "",
            },
        });
    });

    test("parses flag modifier before key-value modifier", () => {
        expect(parseInput("WORK [done] [loc office]")).toEqual({
            type: "WORK",
            description: "",
            modifiers: { done: "", loc: "office" },
        });
    });

    test("parses flag modifier followed by description", () => {
        expect(parseInput("WORK [loc office] [done] some notes")).toEqual({
            type: "WORK",
            description: "some notes",
            modifiers: { loc: "office", done: "" },
        });
    });

    test("flag modifier with underscore key is treated as a modifier", () => {
        expect(parseInput("WORK [flag_with_underscore]")).toEqual({
            type: "WORK",
            description: "",
            modifiers: { flag_with_underscore: "" },
        });
    });

    // -------------------------------------------------------------------------
    // Brackets that stay in the description
    // -------------------------------------------------------------------------

    test("digit-starting brackets remain in description", () => {
        expect(parseInput("note [123] numbers in brackets").description).toBe(
            "[123] numbers in brackets"
        );
    });

    test("bracket starting with underscore stays in description", () => {
        expect(parseInput("TASK [_flag]").description).toBe("[_flag]");
    });

    test("unclosed bracket stays in description", () => {
        expect(parseInput("work [unclosed bracket in description").description).toBe(
            "[unclosed bracket in description"
        );
    });

    // -------------------------------------------------------------------------
    // Modifiers after description text — throw
    // -------------------------------------------------------------------------

    test("throws when key-value modifier appears after description", () => {
        expect(() => parseInput("WORK description [loc office]")).toThrow(
            "Modifiers must appear immediately after the type, before any description text"
        );
    });

    test("throws when flag modifier appears after description", () => {
        expect(() => parseInput("WORK description [done]")).toThrow(
            "Modifiers must appear immediately after the type, before any description text"
        );
    });

    test("throws when bracket without spaces appears after description", () => {
        expect(() =>
            parseInput("task description with [brackets] but no spaces")
        ).toThrow(
            "Modifiers must appear immediately after the type, before any description text"
        );
    });

    test("throws when multiple flag modifiers appear after description", () => {
        expect(() => parseInput("TASK some notes [flag1] [flag2]")).toThrow(
            "Modifiers must appear immediately after the type, before any description text"
        );
    });

    test("throws when modifier appears in the middle of description", () => {
        expect(() => parseInput("TASK some [flag] notes")).toThrow(
            "Modifiers must appear immediately after the type, before any description text"
        );
    });

    test("does not throw for digit-starting bracket after description", () => {
        expect(parseInput("TASK notes [123]")).toEqual({
            type: "TASK",
            description: "notes [123]",
            modifiers: {},
        });
    });

    test("does not throw for underscore-starting bracket after description", () => {
        expect(parseInput("TASK notes [_flag]")).toEqual({
            type: "TASK",
            description: "notes [_flag]",
            modifiers: {},
        });
    });

    // -------------------------------------------------------------------------
    // Whitespace handling
    // -------------------------------------------------------------------------

    test("handles extra whitespace between type and modifier", () => {
        const result = parseInput("WORK  [key]  description");
        expect(result).toEqual({
            type: "WORK",
            description: "description",
            modifiers: { key: "" },
        });
    });

    test("handles extra whitespace between modifiers", () => {
        const result = parseInput("SOCIAL  [with John]   [loc cafe]  notes");
        expect(result).toEqual({
            type: "SOCIAL",
            description: "notes",
            modifiers: { with: "John", loc: "cafe" },
        });
    });
});
