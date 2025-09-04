const memconst = require('../src/memconst');

describe('memconst', () => {
  test('should memoize a synchronous function call', () => {
    // Setup
    const mockFn = jest.fn(() => 'test-value');
    const memoized = memconst(mockFn);

    // Execute
    const result1 = memoized();
    const result2 = memoized();
    const result3 = memoized();

    // Verify
    expect(mockFn).toHaveBeenCalledTimes(1);
    expect(result1).toBe('test-value');
    expect(result2).toBe('test-value');
    expect(result3).toBe('test-value');
  });

  test('should cache the first computed value even if it changes later', () => {
    // Setup
    let counter = 0;
    const incrementingFn = jest.fn(() => `value-${counter++}`);
    const memoized = memconst(incrementingFn);

    // Execute
    const result1 = memoized();
    const result2 = memoized();

    // Verify
    expect(incrementingFn).toHaveBeenCalledTimes(1);
    expect(result1).toBe('value-0');
    expect(result2).toBe('value-0'); // Not 'value-1' because it's memoized
  });

  test('should handle functions that return undefined', () => {
    // Setup
    const undefinedFn = jest.fn(() => undefined);
    const memoized = memconst(undefinedFn);

    // Execute
    const result1 = memoized();
    const result2 = memoized();

    // Verify
    expect(undefinedFn).toHaveBeenCalledTimes(1);
    expect(result1).toBeUndefined();
    expect(result2).toBeUndefined();
  });

  test('should handle functions that return null', () => {
    // Setup
    const nullFn = jest.fn(() => null);
    const memoized = memconst(nullFn);

    // Execute
    const result1 = memoized();
    const result2 = memoized();

    // Verify
    expect(nullFn).toHaveBeenCalledTimes(1);
    expect(result1).toBeNull();
    expect(result2).toBeNull();
  });

  test('should memoize async function calls', async () => {
    // Setup
    const asyncMockFn = jest.fn(async () => 'async-value');
    const memoized = memconst(asyncMockFn);

    // Execute
    const promise1 = memoized();
    const promise2 = memoized();

    // Verify they return the same promise object
    expect(promise1).toBe(promise2);

    // Verify the resolved values
    const result1 = await promise1;
    const result2 = await promise2;
    const result3 = await memoized();

    expect(asyncMockFn).toHaveBeenCalledTimes(1);
    expect(result1).toBe('async-value');
    expect(result2).toBe('async-value');
    expect(result3).toBe('async-value');
  });

  test('should handle errors in async functions properly', async () => {
    // Setup
    const error = new Error('test error');
    const failingAsyncFn = jest.fn(async () => {
      throw error;
    });
    const memoized = memconst(failingAsyncFn);

    // Execute & Verify
    await expect(memoized()).rejects.toThrow('test error');
    await expect(memoized()).rejects.toThrow('test error');
    
    expect(failingAsyncFn).toHaveBeenCalledTimes(1);
  });

  test('should work with real async functions and delays', async () => {
    // Setup
    const sleeper = require('../src/sleeper').make();
    const { fromObject } = require('../src/datetime/duration');
    const delayedFn = jest.fn(async () => {
      await sleeper.sleep(fromObject({milliseconds: 100}));
      return 'delayed-value';
    });
    const memoized = memconst(delayedFn);

    // Execute
    // eslint-disable-next-line volodyslav/no-date-class -- Performance timing test
    const start = Date.now();
    const promise1 = memoized();
    const promise2 = memoized();

    // Verify that the promises are identical
    expect(promise1).toBe(promise2);

    // Wait for the promises to resolve
    const [result1, result2] = await Promise.all([promise1, promise2]);
    // eslint-disable-next-line volodyslav/no-date-class -- Performance timing test
    const end = Date.now();

    // Verify
    expect(delayedFn).toHaveBeenCalledTimes(1);
    expect(result1).toBe('delayed-value');
    expect(result2).toBe('delayed-value');
    
    // We should see only one delay of ~100ms, not two delays
    // Using a large margin to account for Jest overhead
    expect(end - start).toBeLessThan(200);
  });

  test('should handle async functions that return primitives', async () => {
    // Test with different primitive values
    const testCases = [
      { value: 42, desc: 'number' },
      { value: 'string', desc: 'string' },
      { value: true, desc: 'boolean' },
      { value: false, desc: 'boolean' },
      { value: { key: 'value' }, desc: 'object' },
      { value: [1, 2, 3], desc: 'array' }
    ];

    for (const { value } of testCases) {
      // Setup
      const asyncFn = jest.fn(async () => value);
      const memoized = memconst(asyncFn);

      // Execute
      const result1 = await memoized();
      const result2 = await memoized();

      // Verify
      expect(asyncFn).toHaveBeenCalledTimes(1);
      expect(result1).toEqual(value);
      expect(result2).toEqual(value);
    }
  });

  test('should verify real-world usage as in runtime_identifier.js', async () => {
    // Mock the dependencies similar to how runtime_identifier.js uses memconst
    const gitCallMock = jest.fn().mockResolvedValue({ stdout: 'v1.0.0\n' });
    const gitMock = { call: gitCallMock };
    const logErrorMock = jest.fn();
    
    // Setup a function similar to the version function in runtime_identifier.js
    const getVersion = memconst(async () => {
      try {
        const { stdout } = await gitMock.call('-C', '/fake/path', 'describe');
        return stdout.trim();
      } catch (e) {
        logErrorMock({}, 'Could not determine version');
        return 'unknown';
      }
    });
    
    // Execute
    const versionPromise1 = getVersion();
    const versionPromise2 = getVersion();
    
    expect(versionPromise1).toBe(versionPromise2); // Same promise object
    
    const version1 = await versionPromise1;
    const version2 = await versionPromise2;
    
    // Verify
    expect(gitCallMock).toHaveBeenCalledTimes(1);
    expect(version1).toBe('v1.0.0');
    expect(version2).toBe('v1.0.0');
    expect(logErrorMock).not.toHaveBeenCalled();
  });
});
