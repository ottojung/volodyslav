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
