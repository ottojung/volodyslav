const random = require("../src/random");

describe("random.string", () => {
    test("generates a string of default length 16", () => {
        const rng = random.default_generator(42);
        const str = random.string({ rng });
        expect(typeof str).toBe("string");
        expect(str).toHaveLength(16);
        expect(/^[0-9A-Za-z]{16}$/.test(str)).toBe(true);
    });

    test("generates a string of custom length", () => {
        const rng = random.default_generator(42);
        const length = 32;
        const str = random.string({ rng }, length);
        expect(str).toHaveLength(length);
        expect(/^[0-9A-Za-z]+$/.test(str)).toBe(true);
    });

    test("throws a TypeError when length is not a positive integer", () => {
        expect(() => random.string(0)).toThrow(TypeError);
        expect(() => random.string(-5)).toThrow(TypeError);
        expect(() => random.string(1.5)).toThrow(TypeError);
        expect(() => random.string("16")).toThrow(TypeError);
    });
});

describe("random.string with seeded RNG", () => {
    const random = require("../src/random");

    test("same seed produces identical strings", () => {
        const seed = 42;
        const rng1 = random.default_generator(seed);
        const rng2 = random.default_generator(seed);
        const s1 = random.string({ rng: rng1 }, 8);
        const s2 = random.string({ rng: rng2 }, 8);
        expect(s1).toBe(s2);
        expect(s1).toHaveLength(8);
        expect(/^[0-9A-Za-z]{8}$/.test(s1)).toBe(true);
    });

    test("invalid rng argument throws", () => {
        expect(() => random.string({ rng: 5 }, {})).toThrow(TypeError);
    });
});
