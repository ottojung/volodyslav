/**
 * These capabilities are created at the very top of the call stack.
 * This way, only the main entry to the program can grant these capabilities to the rest of the program.
 */

const memconst = require("../memconst");

const random = require("../random");
const deleterCapability = require("../filesystem/deleter");
const dirscanner = require("../filesystem/dirscanner");
const copierCapability = require("../filesystem/copier");
const creatorCapability = require("../filesystem/creator");
const writerCapability = require("../filesystem/writer");

const make = memconst(() => {
    return {
        seed: random.seed.make(),
        deleter: deleterCapability.make(),
        scanner: dirscanner.make(),
        copier: copierCapability.make(),
        creator: creatorCapability.make(),
        writer: writerCapability.make(),
    };
});

module.exports = {
    make,
};
