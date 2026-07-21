const {
    normalizeValueClock,
    validateValueClock,
    valueClocksEqual,
    valueClockDominates,
    valueClocksConcurrent,
    joinValueClocks,
    incrementValueClock,
} = require('../src/generators/incremental_graph/database');

describe('ValueClock algebra', () => {
    test('normalizes to deterministic key order', () => {
        expect(Object.keys(normalizeValueClock({ B: 1, A: 2 }))).toEqual(['A', 'B']);
    });

    test('compares equality, dominance, concurrency, join, and increment', () => {
        expect(valueClocksEqual({ A: 1 }, { A: 1 })).toBe(true);
        expect(valueClockDominates({ A: 2, B: 1 }, { A: 1 })).toBe(true);
        expect(valueClocksConcurrent({ A: 2 }, { A: 1, B: 1 })).toBe(true);
        expect(joinValueClocks({ A: 2 }, { A: 1, B: 1 })).toEqual({ A: 2, B: 1 });
        expect(incrementValueClock({ A: 2 }, 'B')).toEqual({ A: 2, B: 1 });
    });

    test('rejects malformed and empty clocks', () => {
        expect(() => validateValueClock({})).toThrow(/nonempty/);
        expect(() => validateValueClock({ A: 0 })).toThrow(/positive integer/);
        expect(() => validateValueClock({ A: 1.5 })).toThrow(/positive integer/);
        expect(() => validateValueClock(null)).toThrow(/non-array object/);
    });
});
