const crypto = require("crypto");

/**
 * @returns {number} - A random seed.
 * @description This is a wrapper around the crypto.randomBytes function.
 * It generates a 32-bit random seed.
 */
function nondeterministicSeed() {
    // Generate a 32-bit random seed
    const buf = crypto.randomBytes(4);
    const seed = buf.readUInt32LE(0);
    return seed;
}

/**
 * @typedef {object} NonDeterministicSeed
 * @property {typeof nondeterministicSeed} generate - A function that generates a nondeterministic seed.
 */

/**
 * @returns {NonDeterministicSeed}
 */
function make() {
    return {
        generate: nondeterministicSeed,
    };
}

module.exports = {
    make,
};
