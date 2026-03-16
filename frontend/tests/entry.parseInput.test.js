import { getEntryParsed } from "../src/DescriptionEntry/entry.js";

/**
 * Helper to call parseInput via getEntryParsed.
 * @param {string} input
 */
function parseInput(input) {
    return getEntryParsed({ input });
}

describe("parseInput (frontend entry parsing)", () => {
    test("parses minimal input (type only)", () => {
        expect(parseInput("WORK")).toEqual({
            type: "WORK",
            description: "",
            modifiers: {},
        });
    });

    test("parses type with description", () => {
        expect(parseInput("MEAL - Had breakfast")).toEqual({
            type: "MEAL",
            description: "- Had breakfast",
            modifiers: {},
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

    test("parses type with description and modifiers", () => {
        expect(parseInput("WORK [loc office] - Fixed the parser bug")).toEqual({
            type: "WORK",
            description: "- Fixed the parser bug",
            modifiers: {
                loc: "office",
            },
        });
    });

    test("parses flag modifiers (brackets without a value)", () => {
        // Regression test: [audiorecording] should be a modifier with empty value,
        // not description text.
        expect(parseInput("diary [when 0 hours ago] [audiorecording]")).toEqual({
            type: "diary",
            description: "",
            modifiers: {
                when: "0 hours ago",
                audiorecording: "",
            },
        });
    });

    test("parses a single flag modifier", () => {
        expect(parseInput("TASK [done]")).toEqual({
            type: "TASK",
            description: "",
            modifiers: {
                done: "",
            },
        });
    });

    test("digit-starting brackets remain in description", () => {
        expect(parseInput("note [123] numbers in brackets").description).toBe(
            "[123] numbers in brackets"
        );
    });

    test("brackets after description text remain in description", () => {
        expect(
            parseInput("task description with [brackets] but no spaces").description
        ).toBe("description with [brackets] but no spaces");
    });
});
