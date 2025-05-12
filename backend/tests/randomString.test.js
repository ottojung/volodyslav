// file: backend/tests/randomString.test.js
const { generateRandomString } = require('../src/randomString');

describe('generateRandomString', () => {
  test('generates a string of default length 16', () => {
    const str = generateRandomString();
    expect(typeof str).toBe('string');
    expect(str).toHaveLength(16);
    expect(/^[0-9A-Za-z]{16}$/.test(str)).toBe(true);
  });

  test('generates a string of custom length', () => {
    const length = 32;
    const str = generateRandomString(length);
    expect(str).toHaveLength(length);
    expect(/^[0-9A-Za-z]+$/.test(str)).toBe(true);
  });

  test('throws a TypeError when length is not a positive integer', () => {
    expect(() => generateRandomString(0)).toThrow(TypeError);
    expect(() => generateRandomString(-5)).toThrow(TypeError);
    expect(() => generateRandomString(1.5)).toThrow(TypeError);
    expect(() => generateRandomString('16')).toThrow(TypeError);
  });
});
