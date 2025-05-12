const crypto = require('crypto');

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
    get_nondeterministic_seed,
};
