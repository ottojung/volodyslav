const { join } = require('node:path');
const globalSetup = require('../../jest_global_setup');
const { findBudgetOffenders } = globalSetup;
const {
    DEFAULT_TEST_TIMEOUT,
    InvalidTestTimeoutError,
    isInvalidTestTimeoutError,
    resolveTestTimeout,
} = require('../../jest_test_timeout');
const {
    PROJECT_CONFIG_PATHS,
    resolvedProjectConfigPaths,
    resolvedRootConfigPath,
} = require('../../jest_projects');

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

describe('findBudgetOffenders', () => {
    test('accepts declarations which all equal the request', () => {
        expect(findBudgetOffenders(5000, [
            { configPath: 'root', testTimeout: 5000 },
            { configPath: 'backend', testTimeout: 5000 },
        ])).toEqual([]);
    });

    test('rejects a root declaration which disagrees with the request', () => {
        expect(findBudgetOffenders(5000, [
            { configPath: 'root', testTimeout: 30000 },
            { configPath: 'backend', testTimeout: 5000 },
        ])).toEqual(['root declares testTimeout 30000 instead of 5000']);
    });

    test('rejects a missing root declaration', () => {
        expect(findBudgetOffenders(5000, [
            { configPath: 'root' },
        ])).toEqual(['root declares testTimeout undefined instead of 5000']);
    });

    test('rejects a project declaration which disagrees with the request', () => {
        expect(findBudgetOffenders(5000, [
            { configPath: 'root', testTimeout: 5000 },
            { configPath: 'frontend', testTimeout: 1234 },
        ])).toEqual(['frontend declares testTimeout 1234 instead of 5000']);
    });

    test('never consults the effective run value, so a command line override is not drift', () => {
        // Jest seeds globalConfig from argv, so `--testTimeout=N` changes the
        // effective value only. The guard reads declarations, so the very same
        // declarations stay consistent while the effective budget differs.
        expect(findBudgetOffenders(5000, [
            { configPath: 'root', testTimeout: 5000 },
        ])).toEqual([]);
    });
});

describe('assertBudgetIsReachable', () => {
    test('passes on the configuration this repository ships', () => {
        expect(() => globalSetup['assertBudgetIsReachable']()).not.toThrow();
    });

    test('the globalSetup hook ignores the Jest-supplied run configuration', () => {
        // The hook takes no run configuration at all, so no `--testTimeout=N`
        // override can be compared against the request and rejected.
        expect(globalSetup.length).toBe(0);
    });
});

describe('jest_projects', () => {
    test('names exactly the backend and frontend projects', () => {
        expect(PROJECT_CONFIG_PATHS).toEqual([
            '<rootDir>/backend/jest.config.js',
            '<rootDir>/frontend/jest.config.js',
        ]);
    });

    test('every declared config resolves, is requirable and declares the budget', () => {
        const resolved = resolvedProjectConfigPaths();

        expect(resolved).toHaveLength(PROJECT_CONFIG_PATHS.length);

        for (const configPath of resolved) {
            expect(configPath.startsWith('/')).toBe(true);
            expect(require(configPath).testTimeout).toBe(resolveTestTimeout(process.env));
        }
    });

    test('the root config resolves and declares the budget', () => {
        expect(resolvedRootConfigPath()).toBe(join(__dirname, '..', '..', 'jest.config.js'));
        expect(require(resolvedRootConfigPath()).testTimeout).toBe(resolveTestTimeout(process.env));
    });
});
