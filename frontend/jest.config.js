// Jest configuration for frontend project
const { resolveTestTimeout } = require('../jest_test_timeout');

module.exports = {
    displayName: "frontend",
    testTimeout: resolveTestTimeout(process.env),
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
