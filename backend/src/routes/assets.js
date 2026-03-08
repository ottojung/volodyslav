/**
 * Route that serves the event log assets directory as static files.
 * Assets are accessible at /api/assets/<relative-path>.
 */

const express = require("express");

/** @typedef {import('../environment').Environment} Environment */

/**
 * @typedef {object} Capabilities
 * @property {Environment} environment - An environment instance.
 */

/**
 * Creates a router that serves the event log assets directory as static files.
 * @param {Capabilities} capabilities
 * @returns {express.Router}
 */
function makeRouter(capabilities) {
    const router = express.Router();
    const assetsDir = capabilities.environment.eventLogAssetsDirectory();
    router.use("/assets", express.static(assetsDir));
    return router;
}

module.exports = { makeRouter };
