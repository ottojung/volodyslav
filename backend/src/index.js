const { ensureStartupDependencies } = require("./startup");
const expressApp = require("./express_app");
const logger = require("./logger");

/**
 * @returns {Promise<void>}
 */
async function entry() {
    const app = expressApp.make();
    await expressApp.run(app, async (server) => {
        const address = server.address();
        logger.info({ address }, "Server is running");
        await ensureStartupDependencies(app);
        logger.info("Initialization complete.");
    });
}

// Start server if run directly
if (require.main === module) {
    entry();
}

module.exports = {
    entry,
};
