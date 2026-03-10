const { defaultGenerator } = require("../src/random");

const { make } = require("../src/random/interface");

const capabilities = {
    seed: {
        generate: () => 42,
    },
};

describe("RandomNumberGeneratorClass", () => {
    test("defaultGenerator should produce reproducible sequences", () => {
        const rng1 = defaultGenerator(capabilities);
        const rng2 = defaultGenerator(capabilities);
        const seq1 = [rng1.nextFloat(), rng1.nextFloat(), rng1.nextFloat()];
        const seq2 = [rng2.nextFloat(), rng2.nextFloat(), rng2.nextFloat()];
        expect(seq1).toEqual(seq2);
    });

    test("nextInt returns integer within [min, max]", () => {
        const rng = defaultGenerator(capabilities);
        for (let i = 0; i < 10; i++) {
            const val = rng.nextInt(5, 10);
            expect(Number.isInteger(val)).toBe(true);
            expect(val).toBeGreaterThanOrEqual(5);
            expect(val).toBeLessThan(10 + 1);
        }
    });

    test("errors on invalid nextInt arguments", () => {
        const rng = defaultGenerator(capabilities);
        expect(() => rng.nextInt(1.2, 5)).toThrow(TypeError);
        expect(() => rng.nextInt(5, 4)).toThrow(RangeError);
        expect(() => rng.nextInt(10, 5)).toThrow(RangeError);
    });

    test("nextInt handles boundary value when nextFloat returns 1", () => {
        const rng = make({ nextFloat: () => 1 });
        expect(rng.nextInt(5, 10)).toBe(10);
    });

    test("nextInt throws when nextFloat returns invalid value", () => {
        const rng = make({ nextFloat: () => Number.NaN });
        expect(() => rng.nextInt(1, 3)).toThrow(RangeError);
    });
});
