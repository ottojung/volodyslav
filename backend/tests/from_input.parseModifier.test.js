const { parseModifier, isInputParseError } = require("../src/event/from_input");

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
