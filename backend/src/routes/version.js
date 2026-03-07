const express = require("express");
const { getVersion } = require("../version");

/** @typedef {import('../capabilities/root').Capabilities} Capabilities */

/**
 * Handles the GET /version request.
 * @param {import('express').Request} _req
 * @param {import('express').Response} res
 * @param {Capabilities} capabilities
 * @returns {Promise<void>}
 */
async function handleVersionRequest(_req, res, capabilities) {
    const version = await getVersion(capabilities);
    res.json({ version });
}

/**
 * @param {Capabilities} capabilities
 * @returns {import('express').Router}
 */
function makeRouter(capabilities) {
    const router = express.Router();

    router.get("/version", (req, res) =>
        handleVersionRequest(req, res, capabilities)
    );

    return router;
}

module.exports = { makeRouter };
