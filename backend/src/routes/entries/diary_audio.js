/**
 * Handler for POST /entries/diary-audio.
 *
 * Accepts an audio recording and an optional note, constructs the canonical
 * diary rawInput string on the backend, and creates a diary audio entry.
 * This keeps DSL syntax out of the frontend.
 *
 * @module routes/entries/diary_audio
 */

const { createEntry, isEntryValidationError } = require("../../entry");
const { serialize } = require("../../event");
const event = require("../../event");
const fromInput = event.fromInput;
const { processUserInput, isInputParseError } = fromInput;
const { makeFromData } = require("../../filesystem").file_ref;
const { sanitizeFilename, isFilenameValidationError } = require("../../temporary");
const { FileValidationError, handleEntryError } = require("./post");

/** @typedef {import('../../environment').Environment} Environment */
/** @typedef {import('../../logger').Logger} Logger */
/** @typedef {import('../../random/seed').NonDeterministicSeed} NonDeterministicSeed */
/** @typedef {import('../../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../../filesystem/copier').FileCopier} FileCopier */
/** @typedef {import('../../filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('../../filesystem/appender').FileAppender} FileAppender */
/** @typedef {import('../../filesystem/deleter').FileDeleter} FileDeleter */
/** @typedef {import('../../filesystem/reader').FileReader} FileReader */
/** @typedef {import('../../subprocess/command').Command} Command */
/** @typedef {import('../../sleeper').SleepCapability} SleepCapability */
/** @typedef {import('../../generators').Interface} Interface */
/** @typedef {import('../../temporary').Temporary} Temporary */
/** @typedef {import('../../datetime').Datetime} Datetime */

/**
 * @typedef {object} Capabilities
 * @property {Environment} environment
 * @property {Logger} logger
 * @property {NonDeterministicSeed} seed
 * @property {FileDeleter} deleter
 * @property {FileCopier} copier
 * @property {FileWriter} writer
 * @property {FileAppender} appender
 * @property {FileCreator} creator
 * @property {FileChecker} checker
 * @property {Command} git
 * @property {FileReader} reader
 * @property {Datetime} datetime
 * @property {SleepCapability} sleeper
 * @property {Interface} interface
 * @property {Temporary} temporary
 */

/**
 * Handles POST /entries/diary-audio.
 *
 * Expects multipart/form-data:
 *   audio  - binary audio blob (required, field name "audio")
 *   note   - optional plain-text annotation (string, optional)
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {Capabilities} capabilities
 * @param {import('../../request_identifier').RequestIdentifier} reqId
 */
async function handleDiaryAudioPost(req, res, capabilities, reqId) {
    const audioFile = req.file;
    if (!audioFile) {
        return res.status(400).json({ error: "Missing audio file" });
    }

    const { note } = req.body || {};
    const noteStr = typeof note === "string" ? note.trim() : "";

    const rawInput = noteStr
        ? `diary [audiorecording] ${noteStr}`
        : "diary [audiorecording]";

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
                    client_ip: req.ip,
                },
                "Diary audio entry creation failed - input parse error"
            );
            return res.status(400).json({ error: error.message });
        }
        throw error;
    }

    const { original, input } = processed;

    // Sanitize and validate the audio filename.
    let audioFilename;
    try {
        audioFilename = sanitizeFilename(audioFile.originalname);
    } catch (error) {
        if (isFilenameValidationError(error)) {
            return res.status(400).json({ error: `Invalid filename: ${audioFile.originalname}` });
        }
        throw error;
    }
    if (audioFilename !== audioFile.originalname) {
        return res.status(400).json({ error: `Invalid filename: ${audioFile.originalname}` });
    }

    // Build a lazy FileRef from the uploaded buffer.
    const audioBuffer = audioFile.buffer;
    const audioFileRef = makeFromData(audioFilename, async () => audioBuffer);

    try {
        const event = await createEntry(
            capabilities,
            { original, input },
            [audioFileRef]
        );

        capabilities.logger.logDebug(
            {
                request_identifier: reqId.identifier,
                status_code: 201,
                client_ip: req.ip,
            },
            "Diary audio entry created successfully"
        );

        return res.status(201).json({
            success: true,
            entry: serialize(capabilities, event),
        });
    } catch (error) {
        if (error instanceof FileValidationError) {
            return res.status(400).json({ error: error.message });
        }
        if (isEntryValidationError(error)) {
            return res.status(400).json({ error: error.message });
        }
        const errorResponse = handleEntryError(error, capabilities, reqId);
        return res.status(500).json(errorResponse);
    }
}

module.exports = { handleDiaryAudioPost };
