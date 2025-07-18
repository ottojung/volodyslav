const path = require("path");
const { makeDirectory, markDone } = require("./request_identifier");
const creatorMake = require("./creator");

/** @typedef {import("./filesystem/reader").FileReader} FileReader */

/** @typedef {import('./filesystem/file').ExistingFile} ExistingFile */

/** @typedef {import('./random/seed').NonDeterministicSeed} NonDeterministicSeed */
/** @typedef {import('./filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('./filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('./filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('./subprocess/command').Command} Command */
/** @typedef {import('./environment').Environment} Environment */
/** @typedef {import('./logger').Logger} Logger */
/** @typedef {import('./ai/transcription').AITranscription} AITranscription */

/**
 * @typedef {object} Capabilities
 * @property {NonDeterministicSeed} seed - A random number generator instance.
 * @property {FileCreator} creator - A file system creator instance.
 * @property {FileChecker} checker - A file system checker instance.
 * @property {FileWriter} writer - A file system writer instance.
 * @property {import('./filesystem/reader').FileReader} reader - A file reader instance.
 * @property {Command} git - A command instance for Git operations (optional if not always used).
 * @property {Environment} environment - An environment instance.
 * @property {Logger} logger - A logger instance.
 * @property {AITranscription} aiTranscription - An AI transcription instance.
 */

class InputNotFound extends Error {
    /** @type {string} */
    path;

    /**
     * @param {string} message
     * @param {string} path
     */
    constructor(message, path) {
        super(message);
        this.path = path;
    }
}

/**
 * Checks if the given object is an instance of InputNotFound.
 * @param {unknown} object
 * @returns {object is InputNotFound}
 */
function isInputNotFound(object) {
    return object instanceof InputNotFound;
}

/**
 * Minimal capabilities needed for transcribing streams
 * @typedef {object} TranscribeStreamCapabilities
 * @property {AITranscription} aiTranscription - An AI transcription instance
 * @property {NonDeterministicSeed} seed - A random number generator instance
 * @property {Environment} environment - An environment instance
 * @property {Logger} logger - A logger instance
 * @property {Command} git - A command instance for Git operations
 * @property {import('./filesystem/reader').FileReader} reader - A file reader instance
 * @property {import('./filesystem/checker').FileChecker} checker - A file checker instance
 */

/**
 * Minimal capabilities needed for transcribing files
 * @typedef {object} TranscribeFileCapabilities
 * @property {FileCreator} creator - A file system creator instance
 * @property {FileWriter} writer - A file system writer instance
 * @property {AITranscription} aiTranscription - An AI transcription instance
 * @property {NonDeterministicSeed} seed - A random number generator instance
 * @property {Environment} environment - An environment instance
 * @property {Logger} logger - A logger instance
 * @property {Command} git - A command instance for Git operations
 * @property {import('./filesystem/reader').FileReader} reader - A file reader instance
 * @property {import('./filesystem/checker').FileChecker} checker - A file checker instance
 */

/**
 * Minimal capabilities needed for transcribing requests
 * @typedef {object} TranscribeRequestCapabilities
 * @property {FileCreator} creator - A file system creator instance
 * @property {FileChecker} checker - A file system checker instance
 * @property {FileWriter} writer - A file system writer instance
 * @property {Environment} environment - An environment instance
 * @property {AITranscription} aiTranscription - An AI transcription instance
 * @property {NonDeterministicSeed} seed - A random number generator instance
 * @property {Logger} logger - A logger instance
 * @property {Command} git - A command instance for Git operations
 * @property {import('./filesystem/reader').FileReader} reader - A file reader instance
 */

/** @typedef {import('./creator').Creator} Creator */

/**
 * @typedef {Object} Transcriber
 * @property {string} name - The name of the transcriber.
 * @property {string} creator - The creator of the transcriber.
 */

/**
 * @typedef {Object} Transcription
 * @property {string} text - The transcribed text
 * @property {Transcriber} transcriber - The transcriber used
 * @property {Creator} creator - The creator of the transcription
 */

/**
 * Transcribe input stream.
 * @param {TranscribeStreamCapabilities} capabilities
 * @param {import('fs').ReadStream} file_stream
 * @returns {Promise<Transcription>}
 */
async function transcribeStream(capabilities, file_stream) {
    // Make the API call using the AI transcription capability
    const response_text = await capabilities.aiTranscription.transcribeStream(file_stream);
    const transcriber = capabilities.aiTranscription.getTranscriberInfo();
    const creator = await creatorMake(capabilities);

    // Wrap into an abstracted structure
    return {
        text: response_text,
        transcriber,
        creator,
    };
}

/**
 * Transcribe input file.
 * @param {TranscribeFileCapabilities} capabilities
 * @param {ExistingFile} inputFile
 * @param {string} outputPath
 * @returns {Promise<ExistingFile>}
 */
async function transcribeFile(capabilities, inputFile, outputPath) {
    const file_stream = capabilities.reader.createReadStream(inputFile);
    const transcription = await transcribeStream(capabilities, file_stream);

    // Persist full JSON to disk
    const outputFile = await capabilities.creator.createFile(outputPath);
    await capabilities.writer.writeFile(
        outputFile,
        JSON.stringify(transcription, null, 2)
    );

    return outputFile;
}

/**
 * Transcribe a request.
 * @param {TranscribeRequestCapabilities} capabilities
 * @param {string} inputPath
 * @param {import('./request_identifier').RequestIdentifier} reqId
 * @returns {Promise<void>}
 */
async function transcribeRequest(capabilities, inputPath, reqId) {
    const outputFile = "transcription.json";
    const targetDir = await makeDirectory(capabilities, reqId);
    const outputPath = path.join(targetDir, outputFile);

    try {
        const inputFile = await capabilities.checker
            .instantiate(inputPath)
            .catch(() => {
                throw new InputNotFound(
                    `Input file ${inputPath} not found.`,
                    inputPath
                );
            });

        await transcribeFile(capabilities, inputFile, outputPath);
    } finally {
        await markDone(capabilities, reqId);
    }
}

module.exports = {
    isInputNotFound,
    transcribeStream,
    transcribeFile,
    transcribeRequest,
};
