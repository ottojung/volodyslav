const rootRouter = require("./routes/root");
const uploadRouter = require("./routes/upload");
const pingRouter = require("./routes/ping");
const staticRouter = require("./routes/static");
const transcribeRouter = require("./routes/transcribe");
const transcribeAllRouter = require("./routes/transcribe_all");
const periodicRouter = require("./routes/periodic");
const entriesRouter = require("./routes/entries");
const configRouter = require("./routes/config");
const expressApp = require("./express_app");
const { scheduleAll, ensureDailyTasksAvailable } = require("./jobs");
const eventLogStorage = require("./event_log_storage");

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
/** @typedef {import('./capabilities/root').Capabilities} Capabilities */
/** @typedef {import('./ai/transcription').AITranscription} AITranscription */
/** @typedef {import('./exiter').Exiter} Exiter */

/**
 * @param {Capabilities} capabilities
 * @param {import("express").Express} app
 * @returns {void}
 * @description Adds routes to the Express application.
 */
function addRoutes(capabilities, app) {
    app.use("/api", uploadRouter.makeRouter(capabilities));
    app.use("/api", rootRouter.makeRouter(capabilities));
    app.use("/api", pingRouter.makeRouter(capabilities));
    app.use("/api", transcribeRouter.makeRouter(capabilities));
    app.use("/api", transcribeAllRouter.makeRouter(capabilities));
    app.use("/api", periodicRouter.makeRouter(capabilities));
    app.use("/api", entriesRouter.makeRouter(capabilities));
    app.use("/api", configRouter.makeRouter(capabilities));
    app.use("/", staticRouter.makeRouter(capabilities));
}

/**
 * @param {Capabilities} capabilities
 * @param {import('express').Express} app
 * @returns {Promise<void>} - A promise that resolves when the dependencies are ensured.
 * @description Ensures that the necessary startup dependencies are available.
 */
async function ensureStartupDependencies(capabilities, app) {
    addRoutes(capabilities, app);
    await capabilities.environment.ensureEnvironmentIsInitialized(
        capabilities.environment
    );
    await capabilities.notifier.ensureNotificationsAvailable();
    await capabilities.git.ensureAvailable();
    await eventLogStorage.ensureAccessible(capabilities);
    await capabilities.state.ensureAccessible();
    await ensureDailyTasksAvailable(capabilities);
    await capabilities.wifiChecker.ensureAvailable();
}

/**
 * @param {Capabilities} capabilities
 * @param {import("express").Express} app
 */
async function initialize(capabilities, app) {
    await ensureStartupDependencies(capabilities, app);
    await scheduleAll(capabilities);
    capabilities.logger.logInfo({}, "Initialization complete.");
}

/**
 * Converts an address object to a string representation.
 * @param {ReturnType<import("http").Server["address"]>} address - The address object.
 * @returns {string} - The string representation of the address.
 */
function addressToString(address) {
    if (typeof address === "string") {
        return address;
    }
    if (address === null) {
        return "unknown";
    }
    return `${address.address}:${address.port}`;
}

/**
 * @param {Capabilities} capabilities
 */
async function startWithCapabilities(capabilities) {
    await capabilities.logger.setup();
    const app = expressApp.make();
    capabilities.logger.enableHttpCallsLogging(app);
    await expressApp.run(capabilities, app, async (app, server) => {
        const address = server.address();
        const addressString = addressToString(address);
        capabilities.logger.logInfo(
            { address },
            `Server started on ${addressString}`
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
