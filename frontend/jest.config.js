// Jest configuration for frontend project
const { resolveTestTimeout } = require('../jest_test_timeout');
const { isGlobalConfigurationOfThisRun, maxWorkersForConfiguration } = require("../scripts");

/**
 * Resolved on every path this file is read on, before the question of whether
 * this file states the count at all.
 *
 * Jest run with this workspace as its root finds this file and no other, so
 * without the count below JEST_MAX_WORKERS would have no reader here and every
 * start of this project's tests would run at Jest's own default of one worker per
 * core minus one. Resolving the count before deciding whether to state it is what
 * makes every way of naming this file refuse a value that is not a worker count.
 */
const workerCount = maxWorkersForConfiguration(process.env);

module.exports = {
    displayName: "frontend",
    testTimeout: resolveTestTimeout(process.env),
    /**
     * Stated only when this file is the global configuration of the run being
     * read. Read as one project of the repository run, the worker count is a global
     * option that Jest answers "is not supported in an individual project
     * configuration", and the repository jest.config.js has already resolved the
     * same value from the same variable and refused it if it was not a worker
     * count.
     */
    ...(isGlobalConfigurationOfThisRun(__filename) ? { maxWorkers: workerCount } : {}),
    testEnvironment: "jsdom",
    transform: {
        "^.+[.][jt]sx?$": "babel-jest",
    },
    moduleFileExtensions: ["js", "jsx", "json", "node"],
    setupFilesAfterEnv: ["<rootDir>/tests/setup.js"],
    moduleNameMapper: {
        "\\.css$": "<rootDir>/tests/styleMock.js",
    },
};
