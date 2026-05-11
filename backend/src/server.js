const routes = require("./routes");
const rootRouter = routes.root;
const uploadRouter = routes.upload;
const pingRouter = routes.ping;
const staticRouter = routes.static;
const transcribeRouter = routes.transcribe;
const transcribeAllRouter = routes.transcribeAll;
const periodicRouter = routes.periodic;
const entriesRouter = routes.entries;
const configRouter = routes.config;
const ontologyRouter = routes.ontology;
const syncRouter = routes.sync;
const graphRouter = routes.graph;
const versionRouter = routes.version;
const assetsRouter = routes.assets;
const audioRecordingSessionRouter = routes.audioRecordingSession;
const diarySummaryRouter = routes.diarySummary;
const expressApp = require("./express_app");
const { scheduleAll, ensureDailyTasksAvailable } = require("./jobs");
const { getBasePath } = require("./base_path");
const runtimeIdentifier = require("./runtime_identifier");

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
/** @typedef {import('./ai/diary_questions').AIDiaryQuestions} AIDiaryQuestions */
/** @typedef {import('./exiter').Exiter} Exiter */

/**
 * @param {Capabilities} capabilities
 * @param {import("express").Express} app
 * @returns {Promise<void>}
 * @description Adds routes to the Express application.
 */
async function addRoutes(capabilities, app) {
    const basePath = await getBasePath(capabilities);
    app.use(`${basePath}/api`, uploadRouter.makeRouter(capabilities));
    app.use(`${basePath}/api`, rootRouter.makeRouter(capabilities));
    app.use(`${basePath}/api`, pingRouter.makeRouter(capabilities));
    app.use(`${basePath}/api`, transcribeRouter.makeRouter(capabilities));
    app.use(`${basePath}/api`, transcribeAllRouter.makeRouter(capabilities));
    app.use(`${basePath}/api`, periodicRouter.makeRouter(capabilities));
    app.use(`${basePath}/api`, entriesRouter.makeRouter(capabilities));
    app.use(`${basePath}/api`, configRouter.makeRouter(capabilities));
    app.use(`${basePath}/api`, ontologyRouter.makeRouter(capabilities));
    app.use(`${basePath}/api`, syncRouter.makeRouter(capabilities));
    app.use(`${basePath}/api`, graphRouter.makeRouter(capabilities));
    app.use(`${basePath}/api`, versionRouter.makeRouter(capabilities));
    app.use(`${basePath}/api`, assetsRouter.makeRouter(capabilities));
    app.use(`${basePath}/api`, audioRecordingSessionRouter.makeRouter(capabilities));
    app.use(`${basePath}/api`, diarySummaryRouter.makeRouter(capabilities));
    app.use(`${basePath}/`, staticRouter.makeRouter(capabilities));

    // Global error handler — catches errors passed via next(err) from any middleware
    // (e.g. multer parse errors, unhandled route errors).  Without this, Express's
    // default handler responds with 500 and logs nothing to the pino logger.
    app.use(/** @param {Error & {status?: number, code?: string}} err @param {import('express').Request} req @param {import('express').Response} res @param {import('express').NextFunction} _next */ (err, req, res, _next) => {
        capabilities.logger.logError(
            {
                path: req.path,
                method: req.method,
                error: err instanceof Error ? err.message : String(err),
                code: err.code,
                stack: err instanceof Error ? err.stack : undefined,
            },
            "Unhandled route error"
        );
        if (!res.headersSent) {
            res.status(err.status || 500).json({ success: false, error: err.message || "Internal error" });
        }
    });
}

/**
 * @param {Capabilities} capabilities
 * @param {import('express').Express} app
 * @returns {Promise<void>} - A promise that resolves when the dependencies are ensured.
 * @description Ensures that the necessary startup dependencies are available.
 */
async function ensureStartupDependencies(capabilities, app) {
    await addRoutes(capabilities, app);
    await capabilities.environment.ensureEnvironmentIsInitialized(
        capabilities.environment
    );
    await capabilities.notifier.ensureNotificationsAvailable();
    await capabilities.git.ensureAvailable();
    await capabilities.rsync.ensureAvailable();
    await capabilities.state.ensureAccessible();
    await ensureDailyTasksAvailable(capabilities);
    await capabilities.wifiChecker.ensureAvailable();
    await capabilities.interface.ensureInitialized();
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
    const { version } = await runtimeIdentifier(capabilities);
    capabilities.logger.logInfo({ version }, `Volodyslav version: ${version}`);
    const app = expressApp.make();
    // The following line is commented out because HTTP call logging is too verbose by default.
    // TODO: configure a better logging strategy for HTTP calls.
    // capabilities.logger.enableHttpCallsLogging(app);
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
