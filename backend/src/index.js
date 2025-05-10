const expressApp = require("./express_app");
const { start } = require("./startup");

/**
 * @returns {Promise<void>}
 */
async function entry() {
    const app = expressApp.make();
    await expressApp.run(app, async (app, _server) => start(app));
}

// Start server if run directly
if (require.main === module) {
    entry();
}

module.exports = {
    entry,
};
