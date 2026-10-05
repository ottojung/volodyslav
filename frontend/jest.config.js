// Jest configuration for frontend project
const { isRootConfigurationOfThisRun, maxWorkersForConfiguration } = require("../scripts");

module.exports = {
    displayName: "frontend",
    /**
     * Jest run with this workspace as its root finds this file and no other, so
     * without this line JEST_MAX_WORKERS would have no reader here and every
     * start of this project's tests would run at Jest's own default of one worker
     * per core minus one.
     *
     * The line appears only when Jest was started in this directory. Read as one
     * project of the repository run, the worker count is a global option that
     * Jest answers "is not supported in an individual project configuration",
     * and the repository jest.config.js has already resolved the same value from
     * the same variable and refused it if it was not a worker count.
     */
    ...(isRootConfigurationOfThisRun(__dirname)
        ? { maxWorkers: maxWorkersForConfiguration(process.env) }
        : {}),
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