const random = require("../src/random");

const capabilities = {
    seed: ({
        generate: () => 42,
    }),
};

describe("random.string", () => {
    test("generates a string of default length 16", () => {
        const str = random.string(capabilities);
        expect(typeof str).toBe("string");
        expect(str).toHaveLength(16);
        expect(/^[0-9A-Za-z]{16}$/.test(str)).toBe(true);
    });

    test("generates a string of custom length", () => {
        const str = random.string(capabilities, 32);
        expect(str).toHaveLength(32);
        expect(/^[0-9A-Za-z]+$/.test(str)).toBe(true);
    });

    test("throws a TypeError when length is not a positive integer", () => {
        expect(() => random.string(capabilities, 0)).toThrow(TypeError);
        expect(() => random.string(capabilities, -5)).toThrow(TypeError);
        expect(() => random.string(capabilities, 1.5)).toThrow(TypeError);
        expect(() => random.string("16")).toThrow(TypeError);
    });
});

describe("random.string with seeded RNG", () => {
    const random = require("../src/random");

    test("invalid rng argument throws", () => {
        expect(() => random.string({ rng: 5 }, {})).toThrow(TypeError);
    });
});
