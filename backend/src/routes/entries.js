const express = require("express");
const upload = require("../storage");
const { createEntry } = require("../entry");
const { fromExisting } = require("../filesystem/file");
const { random: randomRequestId } = require("../request_identifier");

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
    const uploadMiddleware = upload.makeUpload(capabilities);
    const router = express.Router();

    /**
     * POST /entries - Create a new entry
     */
    router.post("/entries", async (req, res, next) => {
        // Generate a random request identifier and attach to req.query
        const reqId = randomRequestId(capabilities);
        req.query["request_identifier"] = reqId.identifier;
        // Call multer upload middleware
        uploadMiddleware.single("file")(req, res, (err) => {
            if (err) return next(err);
            handleEntryPost(req, res, capabilities);
        });
    });

    return router;
}

/**
 * Handles the POST /entries logic after file upload.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {Capabilities} capabilities
 */
async function handleEntryPost(req, res, capabilities) {
    try {
        const { type, description, date, modifiers, original, input } =
            req.body;

        // Basic validation
        if (!type || !description || !original || !input) {
            return res.status(400).json({
                error: "Missing required fields: type, description, original, and input",
            });
        }

        // If modifiers is a string (from multipart), try to parse as JSON
        let parsedModifiers = modifiers;
        if (typeof modifiers === "string") {
            try {
                parsedModifiers = JSON.parse(modifiers);
            } catch {
                parsedModifiers = undefined;
            }
        }

        const entryData = {
            type,
            description,
            date,
            modifiers: parsedModifiers,
            original,
            input,
        };

        // If file is present, wrap as ExistingFileClass using fromExisting
        let fileObj = undefined;
        if (req.file) {
            fileObj = await fromExisting(req.file.path);
        }

        const event = await createEntry(capabilities, entryData, fileObj);

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
        const message = error instanceof Error ? error.message : String(error);
        capabilities.logger.logError(
            { error: message },
            `Failed to create entry: ${message}`
        );
        // Only print stack if present and error is an Error
        if (error instanceof Error && error.stack) {
            console.error("/api/entries error", error, error.stack);
        } else {
            console.error("/api/entries error", error);
        }

        return res.status(500).json({
            error: "Internal server error",
        });
    }
}

module.exports = { makeRouter };
