// const cron = require('node-cron');
const { processDiaryAudios } = require("./diary");
const capabilities = require("./capabilities/root");

async function everyHour() {
    await processDiaryAudios(capabilities.make());
}

async function setup() {
    // cron.schedule('0 * * * *', everyHour);
}

module.exports = {
    setup,
    everyHour,
};
