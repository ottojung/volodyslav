// Generates a random alphanumeric string with cryptographic quality

const ALPHANUMERIC_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * Generates a random alphanumeric string.
 *
 * @param {import('./interface').RNG} rng - RNG instance for reproducibility.
 * @param {number} [length=16] - The length of the generated string. Must be a positive integer.
 * @returns {string} A random alphanumeric string of specified length.
 * @throws {TypeError} If the length is not a positive integer or rng is invalid.
 */
function string(rng, length = 16) {
    if (!Number.isInteger(length) || length < 1) {
        throw new TypeError('Length must be a positive integer');
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
