const { default_generator } = require('../src/random');

describe('RandomNumberGeneratorClass', () => {
  test('default_generator should produce reproducible sequences', () => {
    const seed = 123456;
    const rng1 = default_generator(seed);
    const rng2 = default_generator(seed);
    const seq1 = [rng1.nextFloat(), rng1.nextFloat(), rng1.nextFloat()];
    const seq2 = [rng2.nextFloat(), rng2.nextFloat(), rng2.nextFloat()];
    expect(seq1).toEqual(seq2);
  });

  test('nextInt returns integer within [min, max]', () => {
    const seed = 42;
    const rng = default_generator(seed);
    for (let i = 0; i < 10; i++) {
      const val = rng.nextInt(5, 10);
      expect(Number.isInteger(val)).toBe(true);
      expect(val).toBeGreaterThanOrEqual(5);
      expect(val).toBeLessThan(10 + 1);
    }
  });

  test('errors on invalid constructor seed', () => {
    expect(() => default_generator(1.5)).toThrow(TypeError);
    expect(() => default_generator('seed')).toThrow(TypeError);
  });

  test('errors on invalid nextInt arguments', () => {
    const rng = default_generator(100);
    expect(() => rng.nextInt(1.2, 5)).toThrow(TypeError);
    expect(() => rng.nextInt(5, 4)).toThrow(RangeError);
    expect(() => rng.nextInt(10, 5)).toThrow(RangeError);
  });
});
