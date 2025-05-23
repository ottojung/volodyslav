const express = require("express");
const { createEntry } = require("../entry");

/**
 * @typedef {import('../environment').Environment} Environment
 * @typedef {import('../logger').Logger} Logger
 * @typedef {import('../random/seed').NonDeterministicSeed} NonDeterministicSeed
 * @typedef {import('../filesystem/deleter').FileDeleter} FileDeleter
 * @typedef {import('../filesystem/copier').FileCopier} FileCopier
 * @typedef {import('../filesystem/writer').FileWriter} FileWriter
 * @typedef {import('../filesystem/appender').FileAppender} FileAppender
 * @typedef {import('../filesystem/creator').FileCreator} FileCreator
 * @typedef {import('../filesystem/checker').FileChecker} FileChecker
 * @typedef {import('../subprocess/command').Command} Command
 */

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
 */

/**
 * Creates an Express router for entry-related endpoints.
 *
 * @param {Capabilities} capabilities - An object containing the capabilities.
 * @returns {express.Router} - The configured router.
 */
function makeRouter(capabilities) {
    const router = express.Router();

    /**
     * POST /entries - Create a new entry
     */
    router.post("/entries", async (req, res) => {
        try {
            const { type, description, date, modifiers } = req.body;

            // Basic validation
            if (!type || !description) {
                return res.status(400).json({
                    error: "Missing required fields: type and description",
                });
            }

            const entryData = {
                type,
                description,
                date,
                modifiers,
            };

            const event = await createEntry(capabilities, entryData);

            return res.status(201).json({
                success: true,
                entry: {
                    id: event.id,
                    type: event.type,
                    description: event.description,
                    date: event.date,
                },
            });
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            capabilities.logger.logError(
                { error: message },
                `Failed to create entry: ${message}`
            );

            return res.status(500).json({
                error: "Internal server error",
            });
        }
    });

    return router;
}

module.exports = { makeRouter };
