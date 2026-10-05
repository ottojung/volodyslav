// Jest configuration for the backend project
const { resolveTestTimeout } = require('../jest_test_timeout');

module.exports = {
    displayName: "backend",
    testTimeout: resolveTestTimeout(process.env),
};