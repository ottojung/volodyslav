const { ensureNotificationsAvailable } = require("./notifications");
const { logger, setupHttpCallsLogging } = require("./logger");

/**
 * @typedef {import("http").Server} Server
 */

/**
 * @param {import('express').Express} app
 * @returns {Promise<void>} - A promise that resolves when the dependencies are ensured.
 * @description Ensures that the necessary startup dependencies are available.
 */
async function ensureStartupDependencies(app) {
    await ensureNotificationsAvailable();
    setupHttpCallsLogging(app);
}

/**
 * @param {import("express").Express} app
 * @param {Server} server
 */
async function start(app, server) {
    const address = server.address();
    logger.info({ address }, "Server is running");
    await ensureStartupDependencies(app);
    logger.info("Initialization complete.");
}

module.exports = {
    ensureStartupDependencies,
    start,
};
