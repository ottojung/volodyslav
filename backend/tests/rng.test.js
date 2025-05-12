// file: backend/tests/rng.test.js
const { createRNG, createRandomRNG } = require('../src/rng');

describe('RandomNumberGeneratorClass', () => {
  test('createRNG should produce reproducible sequences', () => {
    const seed = 123456;
    const rng1 = createRNG(seed);
    const rng2 = createRNG(seed);
    const seq1 = [rng1.nextFloat(), rng1.nextFloat(), rng1.nextFloat()];
    const seq2 = [rng2.nextFloat(), rng2.nextFloat(), rng2.nextFloat()];
    expect(seq1).toEqual(seq2);
  });

  test('getSeed returns the original seed', () => {
    const seed = 789;
    const rng = createRNG(seed);
    expect(rng.getSeed()).toBe(seed);
  });

  test('nextInt returns integer within [min, max)', () => {
    const seed = 42;
    const rng = createRNG(seed);
    for (let i = 0; i < 10; i++) {
      const val = rng.nextInt(5, 10);
      expect(Number.isInteger(val)).toBe(true);
      expect(val).toBeGreaterThanOrEqual(5);
      expect(val).toBeLessThan(10);
    }
  });

  test('errors on invalid constructor seed', () => {
    expect(() => createRNG(1.5)).toThrow(TypeError);
    expect(() => createRNG('seed')).toThrow(TypeError);
  });

  test('errors on invalid nextInt arguments', () => {
    const rng = createRNG(100);
    expect(() => rng.nextInt(1.2, 5)).toThrow(TypeError);
    expect(() => rng.nextInt(5, 5)).toThrow(RangeError);
    expect(() => rng.nextInt(10, 5)).toThrow(RangeError);
  });

  test('createRandomRNG produces valid RNG', () => {
    const rng = createRandomRNG();
    expect(Number.isInteger(rng.getSeed())).toBe(true);
    const f = rng.nextFloat();
    expect(typeof f).toBe('number');
    expect(f).toBeGreaterThanOrEqual(0);
    expect(f).toBeLessThan(1);
  });
});
