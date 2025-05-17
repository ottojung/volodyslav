const path = require("path");
const { makeDirectory, markDone } = require("./request_identifier");
const { transcribeFile } = require("./transcribe");

/** @typedef {import('./filesystem/file').ExistingFile} ExistingFile */

/** @typedef {import('./random/seed').NonDeterministicSeed} NonDeterministicSeed */
/** @typedef {import('./filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('./filesystem/checker').FileChecker} Checker */
/** @typedef {import('./filesystem/dirscanner').DirScanner} DirScanner */
/** @typedef {import('./filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('./subprocess/command').Command} Command */

/**
 * @typedef {object} Capabilities
 * @property {NonDeterministicSeed} seed - A random number generator instance.
 * @property {FileCreator} creator - A file system creator instance.
 * @property {Checker} checker - A file system checker instance.
 * @property {DirScanner} dirScanner - A directory scanner instance.
 * @property {FileWriter} writer - A file writer instance.
 * @property {Command} git - A command instance for Git operations.
 */

class InputDirectoryAccess extends Error {
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
 * @typedef {{ source: ExistingFile, message: string }} TranscriptionFailure
 */

/**
 * @typedef {{ source: ExistingFile, target: ExistingFile }} TranscriptionSuccess
 */

/**
 * @typedef {{ successes: TranscriptionSuccess[], failures: TranscriptionFailure[] }} TranscriptionStatus
 */

/**
 * Transcribe a request with a generic namer.
 * @param {Capabilities} capabilities
 * @param {string} inputDir
 * @param {(file: string) => string} targetFun
 * @returns {Promise<TranscriptionStatus>}
 */
async function transcribeAllGeneric(capabilities, inputDir, targetFun) {
    const resolvedDir = path.resolve(inputDir);

    let entries;
    try {
        entries = await capabilities.dirScanner.scanDirectory(resolvedDir);
    } catch {
        throw new InputDirectoryAccess(
            `Could not read input directory`,
            resolvedDir
        );
    }

    const successes = [];
    const failures = [];
    for (const source of entries) {
        const filename = path.basename(source.path);
        const outputPath = targetFun(filename);
        try {
            const target = await transcribeFile(capabilities, source, outputPath);
            successes.push({ source, target });
        } catch (/** @type {unknown} */ err) {
            const internalMessage =
                err instanceof Error ? err.message : String(err);
            const message = `Transcription failed for ${filename}: ${internalMessage}`;
            failures.push({ source, message });
        }
    }

    return { successes, failures };
}

/**
 * Transcribe a request.
 * @param {Capabilities} capabilities
 * @param {string} inputDir
 * @param {string} targetDir
 * @returns {Promise<TranscriptionStatus>}
 */
async function transcribeAllDirectory(capabilities, inputDir, targetDir) {
    /**
     * @param {string} filename
     * @returns {string}
     */
    function namer(filename) {
        const targetName = `${filename}.json`;
        return path.join(targetDir, targetName);
    }

    return transcribeAllGeneric(capabilities, inputDir, namer);
}

/**
 * Transcribe a request.
 * @param {Capabilities} capabilities
 * @param {string} inputDir
 * @param {import('./request_identifier').RequestIdentifier} reqId
 * @returns {Promise<TranscriptionStatus>}
 */
async function transcribeAllRequest(capabilities, inputDir, reqId) {
    const targetDir = await makeDirectory(capabilities, reqId);
    const result = await transcribeAllDirectory(capabilities, inputDir, targetDir);
    await markDone(capabilities, reqId);
    return result;
}

module.exports = {
    InputDirectoryAccess,
    transcribeAllGeneric,
    transcribeAllDirectory,
    transcribeAllRequest,
};
