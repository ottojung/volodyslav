const deleterCapability = require("../filesystem/deleter");
const random = require("../random");
const dirscanner = require("../filesystem/dirscanner");
const copierCapability = require("../filesystem/copier");
const creatorCapability = require("../filesystem/creator");
const writerCapability = require("../filesystem/writer");
const memconst = require("../memconst");

const make = memconst(() => {
    return {
        deleter: deleterCapability.make(),
        seed: random.seed.make(),
        scanner: dirscanner.make(),
        copier: copierCapability.make(),
        creator: creatorCapability.make(),
        writer: writerCapability.make(),
    };
});

module.exports = {
    make,
};
