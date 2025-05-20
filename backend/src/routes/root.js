const express = require("express");

/** @typedef {import('../logger').Logger} Logger */

/**
 * @typedef {object} Capabilities - An empty capabilities object for this route.
 * @property {Logger} logger - A logger instance.
 */

/**
 * Handles the root request.
 * @param {Capabilities} capabilities - The capabilities object (unused in this handler).
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
function handleRootRequest(capabilities, req, res) {
    capabilities.logger.logInfo(
        {
            method: req.method,
            url: req.originalUrl,
            client_ip: req.ip,
            user_agent: req.get("user-agent"),
        },
        "Root endpoint called"
    );

    res.send("Hello World!");
}

/**
 * @param {Capabilities} capabilities
 * @returns {import('express').Router}
 */
function makeRouter(capabilities) {
    const router = express.Router();

    router.get("/", (req, res) => handleRootRequest(capabilities, req, res));

    return router;
}

module.exports = { makeRouter };
