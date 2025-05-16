const { make } = require("./interface");
const { mulberry32 } = require("./mulberry32");

/**
 * @typedef {import('./seed').NonDeterministicSeed} NonDeterministicSeed
 */

/**
 * @typedef {object} Capabilities
 * @property {NonDeterministicSeed} seed - A function that generates a nondeterministic seed.
 */

/**
 * @param {Capabilities} capabilities
 * @returns {import('./interface').RNG} - A random number generator with the given seed.
 * @description This is a wrapper around the mulberry32 PRNG.
 */
function defaultGenerator(capabilities) {
    const seed = capabilities.seed.generate();
    return make({ nextFloat: mulberry32(seed) });
}

module.exports = {
    defaultGenerator,
};
