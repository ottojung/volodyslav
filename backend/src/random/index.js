const { string } = require("./string");
const { defaultGenerator } = require("./default");
const seed = require("./seed");

/**
 * @typedef {import('./interface').RNG} RNG
 */

module.exports = {
    defaultGenerator,
    string,
    seed,
};
