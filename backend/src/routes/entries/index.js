const express = require("express");
const upload = require("../../storage");
const { random: randomRequestId } = require("../../request_identifier");
const { handleEntryPost } = require("./post");
const { handleEntriesGet } = require("./list");
const { handleEntryDelete } = require("./delete");

/**
/**
 * @typedef {import('../../environment').Environment} Environment
 * @typedef {import('../../logger').Logger} Logger
 * @typedef {import('../../random/seed').NonDeterministicSeed} NonDeterministicSeed
 * @typedef {import('../../filesystem/deleter').FileDeleter} FileDeleter
 * @typedef {import('../../filesystem/copier').FileCopier} FileCopier
 * @typedef {import('../../filesystem/writer').FileWriter} FileWriter
 * @typedef {import('../../filesystem/appender').FileAppender} FileAppender
 * @typedef {import('../../filesystem/creator').FileCreator} FileCreator
 * @typedef {import('../../filesystem/checker').FileChecker} FileChecker
 * @typedef {import('../../subprocess/command').Command} Command
 * @typedef {import('../../event/structure').SerializedEvent} SerializedEvent
 * @typedef {import('../../sleeper').Sleeper} Sleeper
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
 * @property {import('../../filesystem/reader').FileReader} reader - A file reader instance.
 * @property {import('../../datetime').Datetime} datetime - Datetime utilities.
 * @property {Sleeper} sleeper - A sleeper instance for delays.
 */

/**
 * Error thrown when file processing fails due to user input issues.
 * This should result in a 400 Bad Request response.
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

        // Call multer upload middleware for multiple files
        uploadMiddleware.array("files")(req, res, async (err) => {
            if (err) {
                capabilities.logger.logError(
                    {
                        request_identifier: reqId.identifier,
                        error: err.message,
                        error_name: err.name,
                        error_code: err.code,
                        error_stack: err.stack,
                        client_ip: req.ip
                    },
                    "File upload middleware error during entry creation"
                );
                return next(err);
            }
            try {
                await handleEntryPost(req, res, capabilities, reqId);
            } catch (error) {
                capabilities.logger.logError(
                    {
                        request_identifier: reqId.identifier,
                        error: error instanceof Error ? error.message : String(error),
                        error_name: error instanceof Error ? error.name : "Unknown",
                        error_stack: error instanceof Error ? error.stack : undefined,
                        client_ip: req.ip
                    },
                    "Unhandled error during entry creation"
                );
                next(error);
            }
        });
    });

    /**
     * GET /entries - List entries with pagination
     */
    router.get("/entries", async (req, res) => {
        // Generate request ID for tracking
        const reqId = randomRequestId(capabilities);

        try {
            await handleEntriesGet(req, res, capabilities, reqId);
        } catch (error) {
            capabilities.logger.logError(
                {
                    request_identifier: reqId.identifier,
                    error: error instanceof Error ? error.message : String(error),
                    error_name: error instanceof Error ? error.name : "Unknown",
                    error_stack: error instanceof Error ? error.stack : undefined,
                    client_ip: req.ip,
                    query: req.query
                },
                "Unhandled error during entries list request"
            );
            // Let handleEntriesGet handle the response if it hasn't been sent yet
            if (!res.headersSent) {
                res.status(500).json({
                    error: "Internal server error",
                });
            }
        }
    });

    /**
     * DELETE /entries - Delete an entry by id
     */
    router.delete("/entries", async (req, res) => {
        const reqId = randomRequestId(capabilities);

        try {
            await handleEntryDelete(req, res, capabilities, reqId);
        } catch (error) {
            capabilities.logger.logError(
                {
                    request_identifier: reqId.identifier,
                    error: error instanceof Error ? error.message : String(error),
                    error_name: error instanceof Error ? error.name : "Unknown",
                    error_stack: error instanceof Error ? error.stack : undefined,
                    client_ip: req.ip,
                    query: req.query,
                },
                "Unhandled error during entry delete request",
            );
            if (!res.headersSent) {
                res.status(500).json({ error: "Internal server error" });
            }
        }
    });

    return router;
}
/**

 * @typedef {object} EntryCreateResponse
 * @property {boolean} success - Whether the entry was created successfully
 * @property {SerializedEvent} entry - The created entry in serialized format
 */

/**
 * @typedef {object} EntryCreateErrorResponse
 * @property {string} error - Error message
 */

/**
 * @typedef {object} EntriesListResponse
 * @property {Array<SerializedEvent>} results - Array of entries in serialized format
 * @property {string|null} next - URL for the next page of results, or null if no more results
 */

/**
 * @typedef {object} EntriesListErrorResponse
 * @property {string} error - Error message
 */

module.exports = { makeRouter };
