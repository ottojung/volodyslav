const { string } = require("./string");
const { nondeterministic_seed } = require("./seed");
const { default_generator } = require("./default");

/**
 * @typedef {import('./interface').RNG} RNG
 */

module.exports = {
    default_generator,
    nondeterministic_seed,
    string,
};
