// file: backend/src/randomString.js
// Generates a random alphanumeric string with cryptographic quality

const crypto = require('crypto');

const ALPHANUMERIC_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * Generates a random alphanumeric string.
 *
 * @param {number} [length=16] - The length of the generated string. Must be a positive integer.
 * @returns {string} A random alphanumeric string of specified length.
 * @throws {TypeError} If the length is not a positive integer.
 */
function generateRandomString(length = 16) {
    if (!Number.isInteger(length) || length < 1) {
        throw new TypeError('Length must be a positive integer');
    }
    const bytes = crypto.randomBytes(length);
    const result = new Array(length);
    const charLen = ALPHANUMERIC_CHARS.length;
    for (let i = 0; i < length; i++) {
        result[i] = ALPHANUMERIC_CHARS[bytes[i] % charLen];
    }
    return result.join('');
}

module.exports = { generateRandomString };
