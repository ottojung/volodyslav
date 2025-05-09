const { ensureStartupDependencies } = require("./startup");
const expressApp = require("./express_app");
const logger = require("./logger");

function entry() {
    const app = expressApp.make();
    expressApp.run(app, async () => {
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
