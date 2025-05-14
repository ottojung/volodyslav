
const cron = require('node-cron');
const { processDiaryAudios } = require("./diary");
const deleterCapability = require("./filesystem/delete_file");
const random = require('./random');

function setup() {
    const deleter = deleterCapability.make();
    const rng = random.default_generator(random.nondeterministic_seed());

    // Schedule a task to run every hour
    cron.schedule('0 * * * *', () => processDiaryAudios(deleter, rng));
}

module.exports = {
    setup,
};
