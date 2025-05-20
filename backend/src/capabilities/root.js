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
const appendCapability = require("../filesystem/appender");
const checkerCapability = require("../filesystem/checker");
const gitCapability = require("../executables").git;
const environmentCapability = require("../environment");

/**
 * This structure collects maximum capabilities that any part of Volodyslav can access.
 * It is supposed to be initialized at the main entry to Volodyslav, and then passed down the call stack.
 * It should be a pure, well-behaved, non-throwing function
 * - because it is required for everything else in Volodyslav to work, including error reporting.
 */
const make = memconst(() => {
    return {
        seed: random.seed.make(),
        deleter: deleterCapability.make(),
        scanner: dirscanner.make(),
        copier: copierCapability.make(),
        creator: creatorCapability.make(),
        writer: writerCapability.make(),
        appender: appendCapability.make(),
        checker: checkerCapability.make(),
        git: gitCapability,
        environment: environmentCapability.make(),
    };
});

module.exports = {
    make,
};
