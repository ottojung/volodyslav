// Generates a pseudo-random string matching /^[a-z]*$/.
// Note: this uses a seeded PRNG and is not suitable for cryptographic purposes.

const { defaultGenerator } = require('./default');

const CHAR_OPTIONS = 'abcdefghijklmnopqrstuvwxyz';

/** @typedef {import('./seed').NonDeterministicSeed} NonDeterministicSeed */

/**
 * @typedef {object} Capabilities
 * @property {NonDeterministicSeed} seed - A random number generator instance.
 */

/**
 * Generates a random lowercase latin string matching /^[a-z]*$/.
 *
 * @param {Capabilities} capabilities - An object containing a random number generator.
 * @param {number} [length=16] - The length of the generated identifier. Must be a positive integer.
 * @returns {string} A random lowercase latin string of specified length.
 * @throws {TypeError} If the length is not a positive integer.
 */
function basicString(capabilities, length = 16) {
    if (!Number.isInteger(length) || length < 1) {
        throw new TypeError('Length must be a positive integer');
    }

    const rng = defaultGenerator(capabilities);
    const result = new Array(length);

    const charLen = CHAR_OPTIONS.length;
    for (let i = 0; i < length; i++) {
        const idx = rng.nextInt(0, charLen - 1);
        result[i] = CHAR_OPTIONS[idx];
    }

    return result.join('');
}

module.exports = { basicString };
