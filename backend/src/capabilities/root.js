
const deleterCapability = require("../filesystem/deleter");
const random = require("../random");
const dirscanner = require("../filesystem/dirscanner");

const deleter = deleterCapability.make();
const rng = random.default_generator(random.nondeterministic_seed());
const scanner = dirscanner.make();

module.exports = {
    deleter,
    rng,
    scanner,
};
