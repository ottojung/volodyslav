const express = require("express");
const { logInfo } = require("../logger");

/**
 * @typedef {object} Capabilities - An empty capabilities object for this route.
 */

/**
 * Handles the root request.
 * @param {Capabilities} _capabilities - The capabilities object (unused in this handler).
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
function handleRootRequest(_capabilities, req, res) {
    logInfo(
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
