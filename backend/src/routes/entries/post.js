const { createEntry, isEntryValidationError } = require("../../entry");
const { serialize } = require("../../event");
const event = require("../../event");
const fromInput = event.fromInput;
const { processUserInput, isInputParseError } = fromInput;
const path = require("path");
const fs = require("fs").promises;
const { sanitizeFilename } = require("../../temporary");

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
 * @typedef {import('../../generators').Interface} Interface
 * @typedef {import('../../temporary').Temporary} Temporary
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
 * @property {Interface} interface - The incremental graph interface capability.
 * @property {Temporary} temporary - The temporary storage capability.
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
 * Prepares ExistingFile objects from files previously stored in the temporary database.
 * Retrieves each blob, writes it to a directory under workDir, and wraps it as an ExistingFile.
 * Filenames are sanitized via path.basename to prevent path traversal attacks.
 *
 * @param {Capabilities} capabilities - The capabilities.
 * @param {Express.Multer.File[]|undefined} files - The uploaded files (multer memory-storage objects).
 * @param {import('../../request_identifier').RequestIdentifier} reqId - Request identifier for tracking.
 * @param {string} workDir - Temporary directory to write blobs into.
 * @returns {Promise<import('../../filesystem/file').ExistingFile[]>} - The file objects.
 */
async function prepareFileObjects(capabilities, files, reqId, workDir) {
    if (!files || !Array.isArray(files) || files.length === 0) {
        return [];
    }

    const fileObjects = [];
    for (const file of files) {
        // Sanitize the filename before any use in key lookups or filesystem paths.
        const filename = sanitizeFilename(file.originalname);
        let buffer;
        try {
            buffer = await capabilities.temporary.getBlob(reqId, filename);
        } catch (error) {
            capabilities.logger.logError(
                {
                    request_identifier: reqId.identifier,
                    error: error instanceof Error ? error.message : String(error),
                    file_name: filename,
                    error_stack: error instanceof Error ? error.stack : undefined,
                },
                "Failed to retrieve uploaded file from temporary database",
            );
            throw new FileValidationError(
                `Invalid file upload: ${filename}`,
                filename
            );
        }

        if (buffer === null) {
            capabilities.logger.logError(
                {
                    request_identifier: reqId.identifier,
                    file_name: filename,
                },
                "Uploaded file not found in temporary database",
            );
            throw new FileValidationError(
                `Uploaded file not found: ${filename}`,
                filename
            );
        }

        const tmpPath = path.join(workDir, filename);
        try {
            await fs.writeFile(tmpPath, buffer);
            const existingFile = await capabilities.checker.instantiate(tmpPath);
            fileObjects.push(existingFile);
        } catch (error) {
            capabilities.logger.logError(
                {
                    request_identifier: reqId.identifier,
                    error: error instanceof Error ? error.message : String(error),
                    file_name: filename,
                    tmp_path: tmpPath,
                    error_stack: error instanceof Error ? error.stack : undefined,
                },
                "Failed to prepare file object for entry creation",
            );
            throw new FileValidationError(
                `Invalid file upload: ${filename}`,
                filename
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
    // Create a temporary directory via capabilities for holding blobs during entry
    // creation. Cleaned up (along with blobs in the temporary database) in the
    // finally block regardless of outcome.
    const workDir = await capabilities.creator.createTemporaryDirectory();
    /** @type {Express.Multer.File[]} */
    let files = [];
    try {
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
            original,
            input,
        };

        const fileObjects = await prepareFileObjects(capabilities, files, reqId, workDir);
        const event = await createEntry(capabilities, entryData, fileObjects);

        capabilities.logger.logDebug(
            {
                request_identifier: reqId.identifier,
                entry_type: parsed.type,
                file_count: fileObjects.length,
                has_modifiers: Object.keys(parsed.modifiers).length > 0,
                status_code: 201,
                client_ip: req.ip
            },
            "Entry created successfully",
        );

        return res.status(201).json({
            success: true,
            entry: serialize(capabilities, event),
        });
    } catch (error) {
        if (error instanceof FileValidationError) {
            capabilities.logger.logInfo(
                {
                    request_identifier: reqId.identifier,
                    error: error.message,
                    file_path: error.filePath,
                    status_code: 400,
                    client_ip: req.ip
                },
                "Entry creation failed - file validation error",
            );
            return res.status(400).json({ error: error.message });
        }

        if (isEntryValidationError(error)) {
            capabilities.logger.logInfo(
                {
                    request_identifier: reqId.identifier,
                    error: error.message,
                    status_code: 400,
                    client_ip: req.ip
                },
                "Entry creation failed - validation error",
            );
            return res.status(400).json({ error: error.message });
        }

        const errorResponse = handleEntryError(error, capabilities, reqId);
        return res.status(500).json(errorResponse);
    } finally {
        // Clean up stored blobs for this request regardless of outcome.
        for (const file of files) {
            await capabilities.temporary.deleteBlob(reqId, file.originalname).catch(() => {});
        }
        // Remove the temporary working directory.
        await capabilities.deleter.deleteDirectory(workDir).catch(() => {});
    }
}

module.exports = {
    FileValidationError,
    prepareFileObjects,
    handleEntryError,
    handleEntryPost,
};
