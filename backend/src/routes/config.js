const express = require("express");
const { getConfig } = require("../config_api");
const { serialize } = require("../config");

/** @typedef {import('../environment').Environment} Environment */
/** @typedef {import('../logger').Logger} Logger */
/** @typedef {import('../random/seed').NonDeterministicSeed} NonDeterministicSeed */
/** @typedef {import('../filesystem/deleter').FileDeleter} FileDeleter */
/** @typedef {import('../filesystem/copier').FileCopier} FileCopier */
/** @typedef {import('../filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('../filesystem/appender').FileAppender} FileAppender */
/** @typedef {import('../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../subprocess/command').Command} Command */
/** @typedef {import('../config/structure').SerializedConfig} SerializedConfig */
/** @typedef {import('../sleeper').SleepCapability} SleepCapability */

/**
 * @typedef {object} Capabilities
 * @property {Environment} environment - An environment instance.
 * @property {Logger} logger - A logger instance.
 * @property {NonDeterministicSeed} seed - A random number generator instance.
 * @property {FileDeleter} deleter - A file deleter instance.
 * @property {FileCopier} copier - A file copier instance.
 * @property {FileWriter} writer - A file writer instance.
 * @property {FileAppender} appender - A file appender instance.
 * @property {FileCreator} creator - A directory creator instance.
 * @property {FileChecker} checker - A file checker instance.
 * @property {Command} git - A command instance for Git operations.
 * @property {import('../filesystem/reader').FileReader} reader - A file reader instance.
 * @property {import('../datetime').Datetime} datetime - Datetime utilities.
 * @property {SleepCapability} sleeper - A sleeper instance for delays.
 */

/**
 * Creates an Express router for config-related endpoints.
 *
 * @param {Capabilities} capabilities - An object containing the capabilities.
 * @returns {express.Router} - The configured router.
 */
function makeRouter(capabilities) {
    const router = express.Router();

    /**
     * GET /config - Get current configuration
     */
    router.get("/config", async (req, res) => {
        await handleConfigGet(req, res, capabilities);
    });

    return router;
}

/**
 * Handles the GET /config logic.
 * @param {import('express').Request} _req
 * @param {import('express').Response} res - Responds with ConfigResponse on success or ConfigErrorResponse on error
 * @param {Capabilities} capabilities
 */
async function handleConfigGet(_req, res, capabilities) {
    try {
        // Get config using the config_api module
        const config = await getConfig(capabilities);

        if (config === null) {
            // Return empty config response when no config exists
            res.json({
                config: null,
            });
        } else {
            // Serialize config and return
            const serializedConfig = serialize(config);
            res.json({
                config: serializedConfig,
            });
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        capabilities.logger.logError(
            {
                error: message,
                stack: error instanceof Error ? error.stack : undefined,
            },
            `Failed to fetch config: ${message}`
        );

        res.status(500).json({
            error: "Internal server error",
        });
    }
}

/**
 * @typedef {object} ConfigResponse
 * @property {SerializedConfig|null} config - The current configuration in serialized format, or null if no config exists
 */

/**
 * @typedef {object} ConfigErrorResponse
 * @property {string} error - Error message
 */

module.exports = { makeRouter };
