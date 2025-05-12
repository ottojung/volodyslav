const { mulberry32 } = require("./mulberry32");
const { make } = require("./interface");
const crypto = require("crypto");

/**
 * @param {number} seed - 32-bit integer seed
 * @returns {import('./interface').RNG} - A random number generator with the given seed.
 * @description This is a wrapper around the mulberry32 PRNG.
 */
function default_generator(seed) {
    return make({ nextFloat: mulberry32(seed) });
}

/**
 * @returns {number} - A random seed.
 * @description This is a wrapper around the crypto.randomBytes function.
 * It generates a 32-bit random seed.
 */
function get_nondeterministic_seed() {
    // Generate a 32-bit random seed
    const buf = crypto.randomBytes(4);
    const seed = buf.readUInt32LE(0);
    return seed;
}

module.exports = {
    default_generator,
    get_nondeterministic_seed,
};
