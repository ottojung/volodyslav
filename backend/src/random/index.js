const { string } = require("./string");
const { defaultGenerator } = require("./default");
const { variableName } = require("./variable_name");
const seed = require("./seed");

/**
 * @typedef {import('./interface').RNG} RNG
 */

module.exports = {
    defaultGenerator,
    string,
    variableName,
    seed,
};
