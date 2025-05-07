const { setupHttpCallsLogging } = require('./logger');
const { ensureNotificationsAvailable } = require('./notifications');

/**
 * @param {import('express').Express} app
 * @returns {Promise<void>} - A promise that resolves when the dependencies are ensured.
 * @description Ensures that the necessary startup dependencies are available.
 */
async function ensureStartupDependencies(app) {
    await ensureNotificationsAvailable();
    setupHttpCallsLogging(app);
}

module.exports = {
    ensureStartupDependencies,
};
