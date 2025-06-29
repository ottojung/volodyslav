const express = require("express");
const { everyHour } = require("../schedule/tasks");

/** @typedef {import('../filesystem/deleter').FileDeleter} FileDeleter */
/** @typedef {import('../random/seed').NonDeterministicSeed} NonDeterministicSeed */
/** @typedef {import('../filesystem/dirscanner').DirScanner} DirScanner */
/** @typedef {import('../filesystem/copier').FileCopier} FileCopier */
/** @typedef {import('../filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('../filesystem/appender').FileAppender} FileAppender */
/** @typedef {import('../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../subprocess/command').Command} Command */
/** @typedef {import('../environment').Environment} Environment */
/** @typedef {import('../logger').Logger} Logger */
/** @typedef {import('../schedule').Scheduler} Scheduler */

/**
 * @typedef {object} Capabilities
 * @property {NonDeterministicSeed} seed
 * @property {FileDeleter} deleter
 * @property {DirScanner} scanner
 * @property {FileCopier} copier
 * @property {FileWriter} writer
 * @property {FileAppender} appender
 * @property {FileCreator} creator
 * @property {FileChecker} checker
 * @property {Command} git
 * @property {Environment} environment - An environment instance.
 * @property {Logger} logger - A logger instance.
 * @property {Scheduler} scheduler - A scheduler instance.
 * @property {import('../filesystem/reader').FileReader} reader - A file reader instance.
 * @property {import('../datetime').Datetime} datetime - Datetime utilities.
 */

/**
 * Handles the periodic task execution request.
 * @param {Capabilities} capabilities
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function handlePeriodicRequest(capabilities, req, res) {
    const query = req.query || {};
    const period = query['period'];

    capabilities.logger.logDebug(
        { method: req.method, url: req.originalUrl, period, client_ip: req.ip, user_agent: req.get('user-agent') },
        "Periodic endpoint called"
    );

    if (!period) {
        return res.status(400).send("Bad Request: period parameter is required");
    }

    switch (period) {
        case "hour":
        case "hourly":
            await everyHour(capabilities);
            return res.send("done");
        default:
            return res.status(400).send("Bad Request: unknown period");
    }
}

/**
 * @param {Capabilities} capabilities
 * @returns {import('express').Router}
 */
function makeRouter(capabilities) {
    const router = express.Router();

    router.get("/periodic", (req, res) => handlePeriodicRequest(capabilities, req, res));

    return router;
}

module.exports = { makeRouter };
