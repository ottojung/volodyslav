const { ensureNotificationsAvailable } = require("./notifications");
const logger = require("./logger");
const rootRouter = require("./routes/root");
const uploadRouter = require("./routes/upload");
const pingRouter = require("./routes/ping");
const staticRouter = require("./routes/static");
const transcribeRouter = require("./routes/transcribe");
const transcribeAllRouter = require("./routes/transcribe_all");
const scheduler = require("./scheduler");
const expressApp = require("./express_app");

/**
 * @param {import("express").Express} app
 * @description Adds routes to the Express application.
 */
function addRoutes(app) {
    // Mount upload and API routers
    app.use("/api", uploadRouter);
    app.use("/api", rootRouter);
    app.use("/api", pingRouter);
    app.use("/api", transcribeRouter);
    app.use("/api", transcribeAllRouter);
    app.use("/", staticRouter);
}

/**
 * @param {import('express').Express} app
 * @returns {Promise<void>} - A promise that resolves when the dependencies are ensured.
 * @description Ensures that the necessary startup dependencies are available.
 */
async function ensureStartupDependencies(app) {
    await addRoutes(app);
    await ensureNotificationsAvailable();
    logger.enableHttpCallsLogging(app);
}

/**
 * @param {import("express").Express} app
 */
async function initialize(app) {
    await ensureStartupDependencies(app);
    await scheduler.setup();
    logger.logInfo({}, "Initialization complete.");
}

async function start() {
    const app = expressApp.make();
    await expressApp.run(app, async (app, server) => {
        const address = server.address();
        logger.logInfo({ address }, `Server started on ${address}`);
        await initialize(app);
    });
}

module.exports = {
    addRoutes,
    ensureStartupDependencies,
    initialize,
    start,
};
