const { isEnvironmentError } = require("./environment");
const expressApp = require("./express_app");
const { gentleWrap } = require("./gentlewrap");
const { initialize } = require("./server");
const logger = require("./logger");

/**
 * @returns {Promise<never>}
 */
async function entryTyped() {
    await logger.setup();
    const app = expressApp.make();
    await expressApp.run(app, async (app, _server) => initialize(app));
    return process.exit(0);
}

/**
 * @type {() => Promise<never>}
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
