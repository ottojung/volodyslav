// Generates a pseudo-random identifier matching /^[a-z_][a-z0-9_]*$/.
// Note: this uses a seeded PRNG and is not suitable for cryptographic purposes.

const { defaultGenerator } = require('./default');

const FIRST_CHAR_OPTIONS = 'abcdefghijklmnopqrstuvwxyz_';
const NEXT_CHAR_OPTIONS = '0123456789abcdefghijklmnopqrstuvwxyz_';

/** @typedef {import('./seed').NonDeterministicSeed} NonDeterministicSeed */

/**
 * @typedef {object} Capabilities
 * @property {NonDeterministicSeed} seed - A random number generator instance.
 */

/**
 * Generates a random identifier matching /^[a-z_][a-z0-9_]*$/.
 *
 * @param {Capabilities} capabilities - An object containing a random number generator.
 * @param {number} [length=16] - The length of the generated identifier. Must be a positive integer.
 * @returns {string} A random identifier of specified length.
 * @throws {TypeError} If the length is not a positive integer.
 */
function variableName(capabilities, length = 16) {
    if (!Number.isInteger(length) || length < 1) {
        throw new TypeError('Length must be a positive integer');
    }

    const rng = defaultGenerator(capabilities);
    const result = new Array(length);

    const firstIdx = rng.nextInt(0, FIRST_CHAR_OPTIONS.length - 1);
    result[0] = FIRST_CHAR_OPTIONS[firstIdx];

    const nextCharLen = NEXT_CHAR_OPTIONS.length;
    for (let i = 1; i < length; i++) {
        const idx = rng.nextInt(0, nextCharLen - 1);
        result[i] = NEXT_CHAR_OPTIONS[idx];
    }

    return result.join('');
}

module.exports = { variableName };
