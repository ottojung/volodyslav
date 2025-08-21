const rootCapabilities = require("../src/capabilities/root");

/**
 * Recursively wraps functions in an object with jest.fn spies, preserving behavior.
 * @template T
 * @param {T} real - The real capabilities object or function
 * @returns {T} - A mocked version with same shape where functions are replaced by jest spies
 */
function mockCapabilities(real) {
    // Wrap standalone functions with jest.fn to spy on calls
    if (typeof real === "function") {
        return jest.fn((...args) => real(...args));
    }
    if (real && typeof real === "object") {
        // Preserve prototype so instances keep their type
        const mocked = Array.isArray(real)
            ? []
            : Object.create(Object.getPrototypeOf(real));
        for (const key of Object.keys(real)) {
            mocked[key] = mockCapabilities(real[key]);
        }
        return mocked;
    }
    // Return primitives unchanged
    return real;
}

const getMockedRootCapabilities = () =>
    mockCapabilities(rootCapabilities.make());

module.exports = {
    getMockedRootCapabilities,
};
