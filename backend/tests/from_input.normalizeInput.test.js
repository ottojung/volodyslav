const { normalizeInput } = require("../src/event/from_input");

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
