const random = require("../src/random");

const capabilities = {
    seed: ({
        generate: () => 42,
    }),
};

describe("random.basicString", () => {
    test("generates a lowercase latin string of default length 16", () => {
        const name = random.basicString(capabilities);
        expect(typeof name).toBe("string");
        expect(name).toHaveLength(16);
        expect(/^[a-z]*$/.test(name)).toBe(true);
    });

    test("generates a lowercase latin string of custom length", () => {
        const name = random.basicString(capabilities, 32);
        expect(name).toHaveLength(32);
        expect(/^[a-z]*$/.test(name)).toBe(true);
    });

    test("throws a TypeError when length is not a positive integer", () => {
        expect(() => random.basicString(capabilities, 0)).toThrow(TypeError);
        expect(() => random.basicString(capabilities, -5)).toThrow(TypeError);
        expect(() => random.basicString(capabilities, 1.5)).toThrow(TypeError);
        expect(() => random.basicString(capabilities, "16")).toThrow(TypeError);
    });
});
