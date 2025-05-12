
const { make } = require("./interface");
const { mulberry32 } = require("./mulberry32");

/**
 * @param {number} seed - 32-bit integer seed
 * @returns {import('./interface').RNG} - A random number generator with the given seed.
 * @description This is a wrapper around the mulberry32 PRNG.
 */
function default_generator(seed) {
    if (typeof seed !== "number" || !Number.isInteger(seed)) {
        throw new TypeError("seed must be a 32-bit integer");
    }

    return make({ nextFloat: mulberry32(seed) });
}

module.exports = {
    default_generator,
};
