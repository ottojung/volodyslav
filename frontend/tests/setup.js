// Setup file for Jest tests
require('@testing-library/jest-dom/extend-expect');

// Add polyfills for jsdom
const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;
if (typeof global.structuredClone !== "function") {
    global.structuredClone = (value) => {
        if (value === undefined || value === null) {
            return value;
        }
        return JSON.parse(JSON.stringify(value));
    };
}

// Mock window.scrollTo for jsdom (used by framer-motion animations)
Object.defineProperty(window, "scrollTo", {
    value: jest.fn(),
    writable: true,
});
