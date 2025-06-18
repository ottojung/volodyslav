const express = require("express");
const upload = require("../storage");
const { createEntry, getEntries } = require("../entry");
const { random: randomRequestId } = require("../request_identifier");
const { serialize } = require("../event");
const { processUserInput, InputParseError } = require("../event/from_input");

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
 * @typedef {import('../event/structure').SerializedEvent} SerializedEvent
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
 * @property {import('../filesystem/reader').FileReader} reader - A file reader instance.
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
            if (err) return next(err);
            try {
                await handleEntryPost(req, res, capabilities);
            } catch (error) {
                next(error);
            }
        });
    });

    /**
     * GET /entries - List entries with pagination
     */
    router.get("/entries", async (req, res) => {
        await handleEntriesGet(req, res, capabilities);
    });

    return router;
}

/**
 * @typedef {object} EntryRequestBody
 * @property {string} rawInput - The raw user input to parse
 * @property {string} [date] - Optional date string
 */

/**
 * Prepares the file objects for entry creation if files were uploaded.
 *
 * @param {Capabilities} capabilities - The capabilities.
 * @param {Express.Multer.File[]|undefined} files - The uploaded files.
 * @returns {Promise<import('../filesystem/file').ExistingFile[]>} - The file objects.
 */
async function prepareFileObjects(capabilities, files) {
    if (!files || !Array.isArray(files) || files.length === 0) {
        return [];
    }

    const fileObjects = [];
    for (const file of files) {
        const existingFile = await capabilities.checker.instantiate(file.path);
        fileObjects.push(existingFile);
    }

    return fileObjects;
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
 * @param {import('express').Response} res - Responds with EntryCreateResponse on success or EntryCreateErrorResponse on error
 * @param {Capabilities} capabilities
 */
async function handleEntryPost(req, res, capabilities) {
    try {
        // Handle req.files - multer can provide an object or array
        /** @type {Express.Multer.File[]} */
        let files = [];
        if (Array.isArray(req.files)) {
            files = req.files;
        } else if (req.files && typeof req.files === 'object') {
            // If req.files is an object, it might be { files: [file1, file2] }
            files = req.files['files'] || [];
        }

        // New API: rawInput with optional date
        const { rawInput, date } = req.body;
        if (typeof rawInput !== "string" || rawInput.trim() === "") {
            return res.status(400).json({ error: "Missing required field: rawInput" });
        }

        // Parse and process user input into structured event fields
        let processed;
        try {
            processed = await processUserInput(capabilities, rawInput);
        } catch (error) {
            if (error instanceof InputParseError) {
                return res.status(400).json({ error: error.message });
            }
            throw error;
        }

        const { original, input, parsed } = processed;

        // Construct entry data from parsed input
        const entryData = {
            type: parsed.type,
            description: parsed.description,
            modifiers: parsed.modifiers,
            original,
            input,
            date
        };

        // Prepare file attachments
        const fileObjects = await prepareFileObjects(capabilities, files);

        // Create entry event
        const event = await createEntry(capabilities, entryData, fileObjects);

        return res.status(201).json({ success: true, entry: serialize(event) });
    } catch (error) {
        const errorResponse = handleEntryError(error, capabilities);
        return res.status(500).json(errorResponse);
    }
}

/**
 * @typedef {object} PaginationParams
 * @property {number} page - The current page number (1-based)
 * @property {number} limit - The number of items per page
 */

/**
 * Parses pagination parameters from query string.
 *
 * @param {import('express').Request['query']} query - The request query object.
 * @returns {PaginationParams} - The parsed pagination parameters.
 */
function parsePaginationParams(query) {
    const pageRaw = query["page"];
    const limitRaw = query["limit"];

    const page = Math.max(
        1,
        parseInt(
            pageRaw !== undefined
                ? String(Array.isArray(pageRaw) ? pageRaw[0] : pageRaw)
                : "1",
            10
        ) || 1
    );

    const limit = Math.max(
        1,
        Math.min(
            100,
            parseInt(
                limitRaw !== undefined
                    ? String(Array.isArray(limitRaw) ? limitRaw[0] : limitRaw)
                    : "20",
                10
            ) || 20
        )
    );

    return { page, limit };
}

/**
 * Builds the next page URL if more results exist.
 *
 * @param {import('express').Request} req - The Express request object.
 * @param {PaginationParams} pagination - The current pagination parameters.
 * @param {boolean} hasMore - Whether there are more results available.
 * @returns {string|null} - The next page URL or null if no more results.
 */
function buildNextPageUrl(req, pagination, hasMore) {
    if (!hasMore) {
        return null;
    }

    const url = new URL(
        req.protocol + "://" + req.get("host") + req.originalUrl.split("?")[0]
    );
    url.searchParams.set("page", String(pagination.page + 1));
    url.searchParams.set("limit", String(pagination.limit));

    return url.toString();
}

/**
 * Handles the GET /entries logic.
 * @param {import('express').Request} req
 * @param {import('express').Response} res - Responds with EntriesListResponse on success or EntriesListErrorResponse on error
 * @param {Capabilities} capabilities
 */
async function handleEntriesGet(req, res, capabilities) {
    try {
        // Parse pagination parameters
        const pagination = parsePaginationParams(req.query);

        // Get entries using the entry module
        const result = await getEntries(capabilities, pagination);

        // Build next page URL
        const next = buildNextPageUrl(req, pagination, result.hasMore);

        // Return response
        res.json({
            /** @type {Array<import('../event/structure').SerializedEvent>} */
            results: result.results.map(serialize),
            next,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        capabilities.logger.logError(
            {
                error: message,
                stack: error instanceof Error ? error.stack : undefined,
            },
            `Failed to fetch entries: ${message}`
        );

        res.status(500).json({
            error: "Internal server error",
        });
    }
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
