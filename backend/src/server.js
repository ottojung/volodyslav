const rootRouter = require("./routes/root");
const uploadRouter = require("./routes/upload");
const pingRouter = require("./routes/ping");
const staticRouter = require("./routes/static");
const transcribeRouter = require("./routes/transcribe");
const transcribeAllRouter = require("./routes/transcribe_all");
const periodicRouter = require("./routes/periodic");
const scheduler = require("./scheduler");
const expressApp = require("./express_app");

/** @typedef {import('./filesystem/deleter').FileDeleter} FileDeleter */
/** @typedef {import('./random/seed').NonDeterministicSeed} NonDeterministicSeed */
/** @typedef {import('./filesystem/dirscanner').DirScanner} DirScanner */
/** @typedef {import('./filesystem/copier').FileCopier} FileCopier */
/** @typedef {import('./filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('./filesystem/appender').FileAppender} FileAppender */
/** @typedef {import('./filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('./filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('./subprocess/command').Command} Command */
/** @typedef {import('./environment').Environment} Environment */
/** @typedef {import('./logger').Logger} Logger */
/** @typedef {import('./notifications').Notifier} Notifier */

/**
 * @typedef {object} Capabilities
 * @property {NonDeterministicSeed} seed - A random number generator instance.
 * @property {FileDeleter} deleter - A file deleter instance.
 * @property {DirScanner} scanner - A directory scanner instance.
 * @property {FileCopier} copier - A file copier instance.
 * @property {FileWriter} writer - A file writer instance.
 * @property {FileAppender} appender - A file appender instance.
 * @property {FileCreator} creator - A directory creator instance.
 * @property {FileChecker} checker - A file checker instance.
 * @property {Command} git - A command instance for Git operations.
 * @property {Environment} environment - An environment instance.
 * @property {Logger} logger - A logger instance.
 * @property {Notifier} notifier - A notifier instance.
 */

/**
 * @param {Capabilities} capabilities
 * @param {import("express").Express} app
 * @description Adds routes to the Express application.
 */
function addRoutes(capabilities, app) {
    // Mount upload and API routers
    app.use("/api", uploadRouter.makeRouter(capabilities));
    app.use("/api", rootRouter.makeRouter(capabilities));
    app.use("/api", pingRouter.makeRouter(capabilities));
    app.use("/api", transcribeRouter.makeRouter(capabilities));
    app.use("/api", transcribeAllRouter.makeRouter(capabilities));
    app.use("/api", periodicRouter.makeRouter(capabilities));
    app.use("/", staticRouter.makeRouter(capabilities));
}

/**
 * @param {Capabilities} capabilities
 * @param {import('express').Express} app
 * @returns {Promise<void>} - A promise that resolves when the dependencies are ensured.
 * @description Ensures that the necessary startup dependencies are available.
 */
async function ensureStartupDependencies(capabilities, app) {
    await addRoutes(capabilities, app);
    await capabilities.notifier.ensureNotificationsAvailable();
}

/**
 * @param {Capabilities} capabilities
 * @param {import("express").Express} app
 */
async function initialize(capabilities, app) {
    await ensureStartupDependencies(capabilities, app);
    await scheduler.setup(capabilities);
    capabilities.logger.logInfo({}, "Initialization complete.");
}

/**
 * @param {Capabilities} capabilities
 */
async function startWithCapabilities(capabilities) {
    const app = expressApp.make();
    capabilities.logger.enableHttpCallsLogging(app);
    await expressApp.run(capabilities, app, async (app, server) => {
        const address = server.address();
        capabilities.logger.logInfo(
            { address },
            `Server started on ${JSON.stringify(address)}`
        );
        await initialize(capabilities, app);
    });
}

/**
 * @param {Capabilities} capabilities
 * @returns {() => Promise<void>}
 */
function start(capabilities) {
    return () => startWithCapabilities(capabilities);
}

module.exports = {
    addRoutes,
    ensureStartupDependencies,
    initialize,
    start,
};
