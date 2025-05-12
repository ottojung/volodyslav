// Generates a random alphanumeric string with cryptographic quality

const { nondeterministic_seed } = require('./seed');
const { default_generator } = require('./default');

const ALPHANUMERIC_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * Generates a random alphanumeric string.
 *
 * @param {number} [length=16] - The length of the generated string. Must be a positive integer.
 * @param {import('./interface').RNG} [rng] - Optional RNG instance for reproducibility.
 * @returns {string} A random alphanumeric string of specified length.
 * @throws {TypeError} If the length is not a positive integer or rng is invalid.
 */
function string(length = 16, rng) {
    if (!Number.isInteger(length) || length < 1) {
        throw new TypeError('Length must be a positive integer');
    }

    // Use provided RNG or create a fresh one
    if (rng === undefined) {
        rng = default_generator(nondeterministic_seed());
    }

    const result = new Array(length);
    const charLen = ALPHANUMERIC_CHARS.length;
    for (let i = 0; i < length; i++) {
        const idx = rng.nextInt(0, charLen - 1);
        result[i] = ALPHANUMERIC_CHARS[idx];
    }
    return result.join('');
}

module.exports = { string };
