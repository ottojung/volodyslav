const deleterCapability = require("../filesystem/deleter");
const random = require("../random");
const dirscanner = require("../filesystem/dirscanner");
const memconst = require("../memconst");

const make = memconst(() => {
    return {
        deleter: deleterCapability.make(),
        seed: random.seed.make(),
        scanner: dirscanner.make(),
    };
});

module.exports = {
    make,
};
