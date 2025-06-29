const express = require("express");
const runtimeIdentifier = require("../runtime_identifier");

/** @typedef {import('../random/seed').NonDeterministicSeed} NonDeterministicSeed */
/** @typedef {import('../subprocess/command').Command} Command */
/** @typedef {import('../logger').Logger} Logger */

/**
 * @typedef {object} Capabilities
 * @property {NonDeterministicSeed} seed - A random number generator instance.
 * @property {Command} git - A command instance for Git operations.
 * @property {Logger} logger - A logger instance.
 * @property {import('../filesystem/reader').FileReader} reader - A file reader instance.
 * @property {import('../filesystem/checker').FileChecker} checker - A file checker instance.
 */

/**
 * Handles the ping request.
 * @param {Capabilities} capabilities
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function handlePingRequest(capabilities, req, res) {
    /** @type {any} */
    const query = req.query;
    const id = query["runtime_identifier"];

    if (id !== undefined) {
        if (!id) {
            return res.status(400).send("Bad Request");
        }
        // runtimeIdentifier now expects capabilities
        const { instanceIdentifier } = await runtimeIdentifier(capabilities);
        if (id !== instanceIdentifier) {
            return res.status(400).send("Identifiers do not match.");
        }
    }

    return res.send("pong");
}

/**
 * @param {Capabilities} capabilities
 * @returns {import('express').Router}
 */
function makeRouter(capabilities) {
    const router = express.Router();

    router.get("/ping", (req, res) =>
        handlePingRequest(capabilities, req, res)
    );

    return router;
}

module.exports = { makeRouter };
