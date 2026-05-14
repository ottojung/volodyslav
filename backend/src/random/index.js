const { string } = require("./string");
const { defaultGenerator } = require("./default");
const { basicString } = require("./basic_string");
const seed = require("./seed");

/**
 * @typedef {import('./interface').RNG} RNG
 */

module.exports = {
    defaultGenerator,
    string,
    basicString,
    seed,
};
