
import { sum } from '../src/utils';

describe('sum utility', () => {
  test('adds two positive numbers', () => {
    expect(sum(1, 2)).toBe(3);
  });

  test('adds negative and positive number', () => {
    expect(sum(-1, 1)).toBe(0);
  });
});
