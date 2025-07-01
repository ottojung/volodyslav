const { parseStructuredInput, isInputParseError } = require("../src/event/from_input");

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

    test("parses type with multiple modifiers", () => {
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

    test("parses type with description and modifiers", () => {
        const result = parseStructuredInput("WORK [loc office] - Fixed the parser bug");
        expect(result).toEqual({
            type: "WORK",
            description: "- Fixed the parser bug",
            modifiers: {
                loc: "office"
            }
        });
    });

    test("throws InputParseError for bad structure", () => {
        expect(() => parseStructuredInput("[invalid] format")).toThrow();
        let err1;
        try {
            parseStructuredInput("[invalid] format");
        } catch (e) {
            err1 = e;
        }
        expect(isInputParseError(err1)).toBe(true);
    });

    test("throws InputParseError when modifiers appear after description", () => {
        expect(() => parseStructuredInput("WORK description [loc office]")).toThrow();
        let err2;
        try {
            parseStructuredInput("WORK description [loc office]");
        } catch (e) {
            err2 = e;
        }
        expect(isInputParseError(err2)).toBe(true);
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
