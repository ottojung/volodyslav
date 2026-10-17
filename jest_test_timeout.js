/**
 * Jest Per-Test Timeout Budget
 *
 * Single source of the per-test timeout budget for every Jest project in this
 * repository.
 *
 * Jest's circus runner reads the budget from `globalConfig.testTimeout` only
 * (`jest-circus` sets circus state from `globalConfig.testTimeout` and ignores
 * `projectConfig.testTimeout`). In a `projects` configuration the root config is
 * what becomes `globalConfig`, so the root `testTimeout` is the only placement
 * that actually changes the budget. `jest_global_setup.js` asserts that.
 */

/** @typedef {import('node:process').ProcessEnv} ProcessEnv */

/**
 * The default per-test timeout budget in milliseconds.
 *
 * This equals Jest's own built-in default, so an unset `JEST_TEST_TIMEOUT` keeps
 * the effective budget at 5000 ms instead of introducing a new number.
 */
const DEFAULT_TEST_TIMEOUT = 5000;

/**
 * An operator asked for a per-test timeout budget that cannot be honoured.
 */
class InvalidTestTimeoutError extends Error {
    /**
     * @param {string} request - The rejected `JEST_TEST_TIMEOUT` value.
     */
    constructor(request) {
        super(`JEST_TEST_TIMEOUT must be a positive integer number of milliseconds, but it was "${request}"`);
        this.name = "InvalidTestTimeoutError";
        this.request = request;
    }
}

/**
 * Whether an unknown thrown value is an {@link InvalidTestTimeoutError}.
 *
 * @param {unknown} object - Value to inspect.
 * @returns {object is InvalidTestTimeoutError}
 */
function isInvalidTestTimeoutError(object) {
    return object instanceof InvalidTestTimeoutError;
}

/**
 * Resolve the per-test timeout budget the operator asked for.
 *
 * The properties this function carries are:
 * - The result is a positive finite integer number of milliseconds.
 * - The result equals `JEST_TEST_TIMEOUT` when that variable is set.
 * - The result equals {@link DEFAULT_TEST_TIMEOUT} when it is unset.
 *
 * The proof of those properties is guaranteed by:
 * - This function is the only place a Jest config obtains the budget, and it
 *   returns a value only after either the branch which parses and range-checks
 *   the request, or the branch which substitutes the constant default.
 *
 * @param {ProcessEnv} environment - Environment to read `JEST_TEST_TIMEOUT` from.
 * @returns {number} Positive finite integer millisecond budget.
 */
function resolveTestTimeout(environment) {
    const request = environment["JEST_TEST_TIMEOUT"];

    if (request === undefined) {
        return DEFAULT_TEST_TIMEOUT;
    }

    const parsed = Number(request);

    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new InvalidTestTimeoutError(request);
    }

    return parsed;
}

module.exports = {
    DEFAULT_TEST_TIMEOUT,
    InvalidTestTimeoutError,
    isInvalidTestTimeoutError,
    resolveTestTimeout,
};