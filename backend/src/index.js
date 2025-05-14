const { isEnvironmentError } = require("./environment");
const expressApp = require("./express_app");
const { gentleWrap } = require("./gentlewrap");
const { initialize } = require("./startup");
const logger = require("./logger");

/**
 * @returns {Promise<void>}
 */
async function entryTyped() {
    await logger.setup();
    const app = expressApp.make();
    await expressApp.run(app, async (app, _server) => initialize(app));
}

/**
 * @type {() => Promise<void>}
 */
const entry = gentleWrap(entryTyped, [
    isEnvironmentError,
]);

// Start server if run directly
if (require.main === module) {
    entry();
}

module.exports = {
    entry,
};
