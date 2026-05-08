const random = require("../src/random");

const capabilities = {
    seed: ({
        generate: () => 42,
    }),
};

describe("random.variableName", () => {
    test("generates an identifier of default length 16", () => {
        const name = random.variableName(capabilities);
        expect(typeof name).toBe("string");
        expect(name).toHaveLength(16);
        expect(/^[a-z_][a-z0-9_]*$/.test(name)).toBe(true);
    });

    test("generates an identifier of custom length", () => {
        const name = random.variableName(capabilities, 32);
        expect(name).toHaveLength(32);
        expect(/^[a-z_][a-z0-9_]*$/.test(name)).toBe(true);
    });

    test("throws a TypeError when length is not a positive integer", () => {
        expect(() => random.variableName(capabilities, 0)).toThrow(TypeError);
        expect(() => random.variableName(capabilities, -5)).toThrow(TypeError);
        expect(() => random.variableName(capabilities, 1.5)).toThrow(TypeError);
        expect(() => random.variableName(capabilities, "16")).toThrow(TypeError);
    });
});
