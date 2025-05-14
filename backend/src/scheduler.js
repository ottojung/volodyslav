
const cron = require('node-cron');
const { processDiaryAudios } = require("./diary");
const deleterCapability = require("./filesystem/delete_file");
const random = require('./random');

async function everyHour() {
    const deleter = deleterCapability.make();
    const rng = random.default_generator(random.nondeterministic_seed());

    await processDiaryAudios(deleter, rng);
}

async function setup() {
    cron.schedule('0 * * * *', everyHour);
}

module.exports = {
    setup,
    everyHour,
};
