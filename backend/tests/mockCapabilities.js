/**
 * Recursively wraps functions in an object with jest.fn spies, preserving behavior.
 * @param {*} real - The real capabilities object or function
 * @returns {*} - A mocked version with same shape where functions are replaced by jest spies
 */
function mockCapabilities(real) {
    // Passthrough for true CommandClass instances (e.g., git, notifications)
    // They have both a .call method and a .command property
    if (
        real &&
        typeof real.call === 'function' &&
        typeof real.command === 'string'
    ) {
        return real;
    }
    // Wrap standalone functions with jest.fn to spy on calls
    if (typeof real === 'function') {
        return jest.fn((...args) => real(...args));
    }
    // Recursively mock object properties
    if (real && typeof real === 'object') {
        const mocked = Array.isArray(real) ? [] : {};
        for (const [key, val] of Object.entries(real)) {
            mocked[key] = mockCapabilities(val);
        }
        return mocked;
    }
    // Return primitives unchanged
    return real;
}

module.exports = { mockCapabilities };
