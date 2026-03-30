// Setup file for Jest tests
require("@testing-library/jest-dom");

// Define __BASE_PATH__ global used by api_base_url.js
global.__BASE_PATH__ = "/";

// Add polyfills for jsdom
const { TextEncoder, TextDecoder, structuredClone: utilStructuredClone } = require('util');
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;
if (typeof global.structuredClone !== "function") {
    if (typeof utilStructuredClone === "function") {
        global.structuredClone = utilStructuredClone;
    } else {
        global.structuredClone = (value) => {
            if (value === undefined || value === null) {
                return value;
            }
            return JSON.parse(JSON.stringify(value));
        };
    }
}

// Mock window.scrollTo for jsdom (used by framer-motion animations)
Object.defineProperty(window, "scrollTo", {
    value: jest.fn(),
    writable: true,
});
