const { createEntry, isEntryValidationError } = require("../../entry");
const { serialize } = require("../../event");
const event = require("../../event");
const fromInput = event.fromInput;
const { processUserInput, isInputParseError } = fromInput;

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
 * @typedef {import('../../sleeper').SleepCapability} SleepCapability
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
 * @property {SleepCapability} sleeper - A sleeper instance for delays.
 */

/**
 * Error thrown when file processing fails due to user input issues.
 * This should result in a 400 Bad Request response.
 */
class FileValidationError extends Error {
    /**
     * @param {string} message - The file validation error message
     * @param {string} filePath - The path of the problematic file
     */
    constructor(message, filePath) {
        super(message);
        this.name = "FileValidationError";
        this.filePath = filePath;
    }
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
 * @param {import('../../request_identifier').RequestIdentifier} reqId - Request identifier for tracking
 * @returns {Promise<import('../../filesystem/file').ExistingFile[]>} - The file objects.
 */
async function prepareFileObjects(capabilities, files, reqId) {
    if (!files || !Array.isArray(files) || files.length === 0) {
        return [];
    }

    const fileObjects = [];
    for (const file of files) {
        try {
            const existingFile = await capabilities.checker.instantiate(file.path);
            fileObjects.push(existingFile);
        } catch (error) {
            capabilities.logger.logError(
                {
                    request_identifier: reqId.identifier,
                    error: error instanceof Error ? error.message : String(error),
                    file_path: file.path,
                    file_name: file.originalname,
                    error_stack: error instanceof Error ? error.stack : undefined
                },
                "Failed to prepare file object for entry creation",
            );
            // Treat file preparation errors as user errors (invalid uploads)
            throw new FileValidationError(
                `Invalid file upload: ${file.originalname}`,
                file.path
            );
        }
    }

    return fileObjects;
}

/**
 * Handles errors during entry creation.
 *
 * @param {Error|unknown} error - The error that occurred.
 * @param {Capabilities} capabilities - The capabilities.
 * @param {import('../../request_identifier').RequestIdentifier} reqId - Request identifier for tracking
 * @returns {object} - The error response.
 */
function handleEntryError(error, capabilities, reqId) {
    const message = error instanceof Error ? error.message : String(error);

    capabilities.logger.logError(
        {
            request_identifier: reqId.identifier,
            error: message,
            error_name: error instanceof Error ? error.name : "Unknown",
            stack: error instanceof Error ? error.stack : undefined,
        },
        `Failed to create entry: ${message}`,
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
 * @param {import('../../request_identifier').RequestIdentifier} reqId - Request identifier for tracking
 */
async function handleEntryPost(req, res, capabilities, reqId) {
    try {
        /** @type {Express.Multer.File[]} */
        let files = [];
        if (Array.isArray(req.files)) {
            files = req.files;
        } else if (req.files && typeof req.files === 'object') {
            files = req.files['files'] || [];
        }

        const { rawInput } = req.body;
        if (typeof rawInput !== "string" || rawInput.trim() === "") {
            capabilities.logger.logError(
                {
                    request_identifier: reqId.identifier,
                    error: "Missing required field: rawInput",
                    body: req.body,
                    status_code: 400,
                    client_ip: req.ip
                },
                "Entry creation failed - missing rawInput field",
            );
            return res.status(400).json({ error: "Missing required field: rawInput" });
        }

        let processed;
        try {
            processed = await processUserInput(capabilities, rawInput);
        } catch (error) {
            if (isInputParseError(error)) {
                capabilities.logger.logError(
                    {
                        request_identifier: reqId.identifier,
                        error: error.message,
                        raw_input: rawInput,
                        status_code: 400,
                        client_ip: req.ip
                    },
                    "Entry creation failed - input parse error (user error)",
                );
                return res.status(400).json({ error: error.message });
            }
            throw error;
        }

        const { original, input, parsed } = processed;
        const entryData = {
            type: parsed.type,
            description: parsed.description,
            modifiers: parsed.modifiers,
            original,
            input,
        };

        const fileObjects = await prepareFileObjects(capabilities, files, reqId);
        const event = await createEntry(capabilities, entryData, fileObjects);

        capabilities.logger.logDebug(
            {
                request_identifier: reqId.identifier,
                entry_type: event.type,
                file_count: fileObjects.length,
                has_modifiers: Object.keys(parsed.modifiers || {}).length > 0,
                status_code: 201,
                client_ip: req.ip
            },
            "Entry created successfully",
        );

        return res.status(201).json({ success: true, entry: serialize(capabilities, event) });
    } catch (error) {
        if (isEntryValidationError(error) || error instanceof FileValidationError) {
            capabilities.logger.logInfo(
                {
                    request_identifier: reqId.identifier,
                    error: error.message,
                    error_name: error.name,
                    status_code: 400,
                    client_ip: req.ip
                },
                "Entry creation failed - validation error (user error)",
            );
            return res.status(400).json({ error: error.message });
        }

        const errorResponse = handleEntryError(error, capabilities, reqId);
        capabilities.logger.logError(
            {
                request_identifier: reqId.identifier,
                status_code: 500,
                client_ip: req.ip
            },
            "Entry creation request completed with status 500",
        );
        return res.status(500).json(errorResponse);
    }
}

module.exports = {
    FileValidationError,
    prepareFileObjects,
    handleEntryError,
    handleEntryPost,
};
