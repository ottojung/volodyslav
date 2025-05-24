const express = require("express");
const upload = require("../storage");
const { createEntry, getEntries } = require("../entry");
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

        // Call multer upload middleware
        uploadMiddleware.single("file")(req, res, (err) => {
            if (err) return next(err);
            handleEntryPost(req, res, capabilities);
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
 * @param {import('express').Response} res - Responds with EntryCreateResponse on success or EntryCreateErrorResponse on error
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
            /** @type {import('../event/structure').SerializedEvent} */
            entry: serialize(event),
        });
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
