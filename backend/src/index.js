const { isEnvironmentError } = require("./environment");
const { gentleWrap } = require("./gentlewrap");
const { start } = require("./server");
const logger = require("./logger");

/**
 * @returns {Promise<never>}
 */
async function entryTyped() {
    await logger.setup();
    await start();
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
