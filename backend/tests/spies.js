const rootCapabilities = require("../src/capabilities/root");

/**
 * Recursively wraps functions in an object with jest.fn spies, preserving behavior.
 * @template T
 * @param {T} real - The real capabilities object or function
 * @returns {T} - A mocked version with same shape where functions are replaced by jest spies
 */
function mockCapabilities(real) {
    if (typeof real === "function") {
        return jest.fn((...args) => real(...args));
    }
    if (real && typeof real === "object") {
        for (const key of Object.keys(real)) {
            real[key] = mockCapabilities(real[key]);
        }
    }

    return real;
}

const getMockedRootCapabilities = () =>
    mockCapabilities(rootCapabilities.make());

module.exports = {
    getMockedRootCapabilities,
};
