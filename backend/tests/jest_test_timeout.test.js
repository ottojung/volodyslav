const {
    DEFAULT_TEST_TIMEOUT,
    InvalidTestTimeoutError,
    isInvalidTestTimeoutError,
    resolveTestTimeout,
} = require('../../jest_test_timeout');

describe('resolveTestTimeout', () => {
    test('defaults to the built-in Jest budget when the operator asks for nothing', () => {
        expect(resolveTestTimeout({})).toBe(DEFAULT_TEST_TIMEOUT);
    });

    test('the default budget equals Jest own 5000 ms default', () => {
        expect(DEFAULT_TEST_TIMEOUT).toBe(5000);
    });

    test('honours a requested budget', () => {
        expect(resolveTestTimeout({ JEST_TEST_TIMEOUT: '1234' })).toBe(1234);
    });

    test.each([
        ['abc', 'a non-numeric request'],
        ['0', 'a zero request'],
        ['-1', 'a negative request'],
        ['1.5', 'a fractional request'],
        ['', 'an empty request'],
    ])('rejects %p because it is %s', (request) => {
        let thrown;

        try {
            resolveTestTimeout({ JEST_TEST_TIMEOUT: request });
        } catch (error) {
            thrown = error;
        }

        expect(isInvalidTestTimeoutError(thrown)).toBe(true);
        expect(thrown).toBeInstanceOf(InvalidTestTimeoutError);
    });
});