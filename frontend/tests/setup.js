// Setup file for Jest tests
require('@testing-library/jest-dom/extend-expect');

// Add polyfills for jsdom
const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;

// Mock window.scrollTo for jsdom (used by framer-motion animations)
Object.defineProperty(window, "scrollTo", {
    value: jest.fn(),
    writable: true,
});

// Suppress React act warnings during tests
// These warnings occur because our mocked API calls create async state updates
// that happen after test assertions, which is normal testing behavior
const originalError = console.error;

console.error = (...args) => {
    // Suppress specific React act warnings
    if (
        typeof args[0] === 'string' &&
        args[0].includes('Warning: An update to') &&
        args[0].includes('inside a test was not wrapped in act(...)')
    ) {
        return;
    }
    
    // Suppress React DOM test utils deprecation warning
    if (
        typeof args[0] === 'string' &&
        args[0].includes('`ReactDOMTestUtils.act` is deprecated')
    ) {
        return;
    }
    
    // Let all other console.error calls through
    originalError.call(console, ...args);
};
