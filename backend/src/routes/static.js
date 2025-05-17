const express = require("express");
const path = require("path");

/**
 * @typedef {object} Capabilities
 */

const staticPath = path.join(__dirname, "..", "..", "..", "frontend", "dist");

/**
 * Handles serving the index.html for all other GET requests.
 * @param {Capabilities} _capabilities - The capabilities object (unused).
 * @param {import('express').Request} _req - The Express request object (unused).
 * @param {import('express').Response} res - The Express response object.
 */
function handleStaticFallback(_capabilities, _req, res) {
    res.sendFile(path.join(staticPath, "index.html"));
}

/**
 * @param {Capabilities} capabilities
 * @returns {import('express').Router}
 */
function makeRouter(capabilities) {
    const router = express.Router();

    router.use(express.static(staticPath));
    router.get("*", (req, res) => handleStaticFallback(capabilities, req, res));

    return router;
}

module.exports = { makeRouter };
