const { isEnvironmentError } = require("./environment");
const expressApp = require("./express_app");
const gentleWrap = require("./gentlewrap");
const { initialize } = require("./startup");

/**
 * @returns {Promise<void>}
 */
async function entryTyped() {
    const app = expressApp.make();
    await expressApp.run(app, async (app, _server) => initialize(app));
}

/**
 * @returns {Promise<void>}
 */
async function entry() {
    await gentleWrap(entryTyped, [isEnvironmentError])();
}

// Start server if run directly
if (require.main === module) {
    entry();
}

module.exports = {
    entry,
};
