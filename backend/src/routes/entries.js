const express = require("express");
const upload = require("../storage");
const { createEntry } = require("../entry");
const { fromExisting } = require("../filesystem/file");
const { random: randomRequestId } = require("../request_identifier");
const { serialize } = require("../event");

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
 * @typedef {object} EntryRequestBody
 * @property {string} type - The type of entry
 * @property {string} description - The description of the entry
 * @property {string} original - The original content
 * @property {string} input - The processed input
 * @property {string} [date] - Optional date string
 * @property {Record<string,string>|string} [modifiers] - Optional modifiers
 */

/**
 * Validates that all required fields are present in the request body.
 *
 * @param {EntryRequestBody} body - The request body.
 * @returns {{isValid: boolean, error?: string}} - Validation result.
 */
function validateEntryFields(body) {
    const { type, description, original, input } = body;

    if (!type || !description || !original || !input) {
        return {
            isValid: false,
            error: "Missing required fields: type, description, original, and input",
        };
    }

    return { isValid: true };
}

/**
 * Parses modifiers from string to object if needed.
 * 
 * @param {Record<string,string>|string|undefined} modifiers - The modifiers to parse.
 * @returns {Record<string,string>|undefined} - Parsed modifiers.
 */
function parseModifiers(modifiers) {
    if (typeof modifiers !== "string") {
        return modifiers;
    }
    
    try {
        return JSON.parse(modifiers);
    } catch {
        return undefined;
    }
}

/**
 * Creates an entry data object from request body.
 *
 * @param {EntryRequestBody} body - The request body.
 * @returns {import('../entry').EntryData} - The entry data.
 */
function createEntryData(body) {
    const { type, description, date, original, input } = body;
    const parsedModifiers = parseModifiers(body.modifiers);

    return {
        type,
        description,
        date,
        modifiers: parsedModifiers,
        original,
        input,
    };
}

/**
 * Prepares the file object for entry creation if a file was uploaded.
 *
 * @param {Express.Multer.File|undefined} file - The uploaded file.
 * @returns {Promise<import('../filesystem/file').ExistingFile|undefined>} - The file object.
 */
async function prepareFileObject(file) {
    if (!file) {
        return undefined;
    }

    return await fromExisting(file.path);
}

/**
 * Handles errors during entry creation.
 *
 * @param {Error|unknown} error - The error that occurred.
 * @param {Capabilities} capabilities - The capabilities.
 * @returns {object} - The error response.
 */
function handleEntryError(error, capabilities) {
    const message = error instanceof Error ? error.message : String(error);

    capabilities.logger.logError(
        {
            error: message,
            stack: error instanceof Error ? error.stack : undefined,
        },
        `Failed to create entry: ${message}`
    );

    return {
        error: "Internal server error",
    };
}

/**
 * Handles the POST /entries logic after file upload.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {Capabilities} capabilities
 */
async function handleEntryPost(req, res, capabilities) {
    try {
        // Validate request fields
        const validation = validateEntryFields(req.body);
        if (!validation.isValid) {
            return res.status(400).json({ error: validation.error });
        }

        // Create entry data and prepare file
        const entryData = createEntryData(req.body);
        const fileObj = await prepareFileObject(req.file);

        // Create entry and return response
        const event = await createEntry(capabilities, entryData, fileObj);

        return res.status(201).json({
            success: true,
            entry: serialize(event),
        });
    } catch (error) {
        const errorResponse = handleEntryError(error, capabilities);
        return res.status(500).json(errorResponse);
    }
}

module.exports = { makeRouter };
