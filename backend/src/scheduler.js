// const cron = require('node-cron');
const { processDiaryAudios } = require("./diary");
const deleterCapability = require("./filesystem/deleter");
const random = require("./random");
const dirscanner = require("./filesystem/dirscanner");

async function everyHour() {
    const deleter = deleterCapability.make();
    const rng = random.default_generator(random.nondeterministic_seed());
    const scanner = dirscanner.make();
    const capabilities = {
        deleter,
        rng,
        scanner,
    };

    await processDiaryAudios(capabilities);
}

async function setup() {
    // cron.schedule('0 * * * *', everyHour);
}

module.exports = {
    setup,
    everyHour,
};
