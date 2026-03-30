const { createEntry, isEntryValidationError } = require("../../entry");
const { serialize } = require("../../event");
const event = require("../../event");
const fromInput = event.fromInput;
const { processUserInput, isInputParseError } = fromInput;
const { sanitizeFilename, isFilenameValidationError } = require("../../temporary");
const { makeFromData } = require("../../filesystem").file_ref;
const { isValidIANATimezone } = require("../../datetime");

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
 * @property {string} clientTimezone - Required IANA timezone name from the client (e.g. "Europe/Kyiv")
 */

/**
 * Prepares FileRef objects from files previously stored in the temporary database.
 * Returns lazy `FileRef` instances whose `data()` reads the blob from the
 * temporary DB only when copyAssets() needs it — no buffer is loaded during
 * this function itself.
 * Filenames are sanitized via sanitizeFilename to prevent path traversal attacks.
 * An invalid filename (empty, ".", "..") is converted to a 400 FileValidationError via
 * FilenameValidationError.  Additionally, any filename whose sanitized form differs from
 * the original (i.e. it contained path separators such as "a/b.txt") is also rejected
 * with a 400, matching the strict behavior of validateFilename() in file_ref.js.
 *
 * @param {Capabilities} capabilities - The capabilities.
 * @param {Express.Multer.File[]|undefined} files - The uploaded files (multer memory-storage objects).
 * @param {import('../../request_identifier').RequestIdentifier} reqId - Request identifier for tracking.
 * @returns {Promise<import('../../filesystem/file_ref').FileRef[]>} - The FileRef objects.
 */
async function prepareFileObjects(capabilities, files, reqId) {
    if (!files || !Array.isArray(files) || files.length === 0) {
        return [];
    }

    const fileRefs = [];
    for (const file of files) {
        // Sanitize the filename before any use in key lookups.
        // A FilenameValidationError means the client sent an unusable filename
        // (empty, dot-only) — convert to 400.
        let filename;
        try {
            filename = sanitizeFilename(file.originalname);
        } catch (error) {
            if (isFilenameValidationError(error)) {
                capabilities.logger.logError(
                    {
                        request_identifier: reqId.identifier,
                        original_name: file.originalname,
                        error: error.message,
                    },
                    "Entry creation failed - invalid uploaded filename",
                );
                throw new FileValidationError(
                    `Invalid filename: ${file.originalname}`,
                    file.originalname
                );
            }
            throw error;
        }

        // Reject filenames that contain path separators.
        // sanitizeFilename() strips directory components via path.basename()
        // without throwing, so we must explicitly reject any input that was
        // normalized (e.g. "a/b.txt" → "b.txt").  This matches the stricter
        // behavior of validateFilename() in file_ref.js.
        if (filename !== file.originalname) {
            capabilities.logger.logError(
                {
                    request_identifier: reqId.identifier,
                    original_name: file.originalname,
                },
                "Entry creation failed - uploaded filename contains path separators",
            );
            throw new FileValidationError(
                `Invalid filename: ${file.originalname}`,
                file.originalname
            );
        }

        // Lazy FileRef: bytes are loaded from temporary storage only when
        // copyAssets() calls data(). No upfront DB read is performed here,
        // avoiding a double load (and double base64 decode) alongside the
        // lazy read that follows.
        fileRefs.push(makeFromData(filename, async () => {
            const buf = await capabilities.temporary.getBlob(reqId, filename);
            if (buf === null) {
                capabilities.logger.logError(
                    {
                        request_identifier: reqId.identifier,
                        file_name: filename,
                    },
                    "Uploaded file missing from temporary database at copy time (may have expired or been cleaned up)",
                );
                throw new FileValidationError(
                    `Uploaded file not found in temporary storage: ${filename}`,
                    filename
                );
            }
            return buf;
        }));
    }

    return fileRefs;
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
    /** @type {Express.Multer.File[]} */
    let files = [];
    try {
        if (Array.isArray(req.files)) {
            files = req.files;
        } else if (req.files && typeof req.files === 'object') {
            files = req.files['files'] || [];
        }

        const { rawInput, clientTimezone } = req.body;
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

        // Validate required clientTimezone field.
        if (clientTimezone === undefined || clientTimezone === null) {
            return res.status(400).json({ error: "Missing required field: clientTimezone" });
        }
        if (typeof clientTimezone !== "string") {
            return res.status(400).json({ error: "clientTimezone must be a string" });
        }
        if (!isValidIANATimezone(clientTimezone)) {
            return res.status(400).json({ error: `Invalid clientTimezone: ${clientTimezone}` });
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
            clientTimezone,
        };

        const fileRefs = await prepareFileObjects(capabilities, files, reqId);
        const event = await createEntry(capabilities, entryData, fileRefs);

        capabilities.logger.logDebug(
            {
                request_identifier: reqId.identifier,
                entry_type: parsed.type,
                file_count: fileRefs.length,
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
        // Clean up the done marker for this request to avoid stale state in temporary storage.
        await capabilities.temporary.deleteDone(reqId).catch(() => {});
    }
}

module.exports = {
    FileValidationError,
    prepareFileObjects,
    handleEntryError,
    handleEntryPost,
};
