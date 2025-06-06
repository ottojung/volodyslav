// Generates a random alphanumeric string using a seeded RNG

const { defaultGenerator } = require('./default');

const ALPHANUMERIC_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';

/** @typedef {import('./seed').NonDeterministicSeed} NonDeterministicSeed */

/**
 * @typedef {object} Capabilities
 * @property {NonDeterministicSeed} seed - A random number generator instance.
 */

/**
 * Generates a random alphanumeric string.
 *
 * @param {Capabilities} capabilities - An object containing a random number generator.
 * @param {number} [length=16] - The length of the generated string. Must be a positive integer.
 * @returns {string} A random alphanumeric string of specified length.
 * @throws {TypeError} If the length is not a positive integer.
 */
function string(capabilities, length = 16) {
    if (!Number.isInteger(length) || length < 1) {
        throw new TypeError('Length must be a positive integer');
    }

    const rng = defaultGenerator(capabilities);    
    const result = new Array(length);
    const charLen = ALPHANUMERIC_CHARS.length;
    for (let i = 0; i < length; i++) {
        const idx = rng.nextInt(0, charLen - 1);
        result[i] = ALPHANUMERIC_CHARS[idx];
    }
    return result.join('');
}

module.exports = { string };
