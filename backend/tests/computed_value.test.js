const { assertComputedValue, isEqual } = require("../src/generators/incremental_graph/computed_value");
const { computeEntryDescription } = require("../src/generators/individual/entry_description");
const { deserialize } = require("../src/event");

class UnsupportedComputedValue {}

function validate(value) {
    assertComputedValue(value, new Error("invalid ComputedValue"));
    return value;
}

describe("ComputedValue persistence boundary", () => {
    test.each([
        { type: "config", config: null },
        { type: "entry_description", description: null },
        { nested: [0, -0, 1.25, true, "text", null, { finite: -2 }] },
    ])("round-trips production value %#", (value) => {
        expect(isEqual(JSON.parse(JSON.stringify(validate(value))), value)).toBe(true);
    });

    test("entry-description absence has a fixed null field", () => {
        const event = deserialize({
            id: "event-id",
            date: "2025-01-01T00:00:00.000Z",
            original: "task without diary text",
            input: "task without diary text",
            creator: { name: "test", uuid: "test", version: "1", hostname: "test" },
        });
        const result = computeEntryDescription(event);
        expect(result).toEqual({ type: "entry_description", description: null });
        expect(JSON.parse(JSON.stringify(validate(result)))).toEqual(result);
    });

    test.each([
        NaN,
        Infinity,
        -Infinity,
        { nested: { missing: undefined } },
        BigInt(1),
        new UnsupportedComputedValue(),
    ])("rejects unsupported value %#", (value) => {
        expect(() => validate(value)).toThrow("invalid ComputedValue");
    });

    test("rejects sparse arrays", () => {
        const sparse = [];
        sparse.length = 1;
        expect(() => validate(sparse)).toThrow("invalid ComputedValue");
    });

    test("uses ECMAScript record enumeration semantics", () => {
        const numericFirst = {};
        numericFirst["2"] = "two";
        numericFirst["1"] = "one";
        expect(Object.keys(numericFirst)).toEqual(["1", "2"]);
        expect(isEqual(numericFirst, { "1": "one", "2": "two" })).toBe(true);
        expect(JSON.stringify(numericFirst)).toBe(JSON.stringify({ "1": "one", "2": "two" }));
        expect(isEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false);
        expect(isEqual(-0, 0)).toBe(true);
    });
});
