const path = require("path");
const os = require("os");
const fs = require("fs").promises;
const { transcribeFile } = require("./transcribe");

/** @typedef {import('./filesystem/file').ExistingFile} ExistingFile */

/** @typedef {import('./random/seed').NonDeterministicSeed} NonDeterministicSeed */
/** @typedef {import('./filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('./filesystem/checker').FileChecker} Checker */
/** @typedef {import('./filesystem/dirscanner').DirScanner} DirScanner */
/** @typedef {import('./filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('./subprocess/command').Command} Command */
/** @typedef {import('./environment').Environment} Environment */
/** @typedef {import('./logger').Logger} Logger */
/** @typedef {import('./ai/transcription').AITranscription} AITranscription */
/** @typedef {import('./temporary').Temporary} Temporary */

/**
 * @typedef {object} Capabilities
 * @property {NonDeterministicSeed} seed - A random number generator instance.
 * @property {FileCreator} creator - A file system creator instance.
 * @property {Checker} checker - A file system checker instance.
 * @property {DirScanner} scanner - A directory scanner instance.
 * @property {FileWriter} writer - A file writer instance.
 * @property {Command} git - A command instance for Git operations.
 * @property {Environment} environment - An environment instance.
 * @property {Logger} logger - A logger instance.
 * @property {AITranscription} aiTranscription - An AI transcription instance.
 * @property {import('./filesystem/reader').FileReader} reader - A file reader instance.
 * @property {Temporary} temporary - The temporary storage capability.
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
        entries = await capabilities.scanner.scanDirectory(resolvedDir);
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
        const targetPath = targetFun(filename);
        try {
            const target = await transcribeFile(
                capabilities,
                source,
                targetPath
            );
            successes.push({ source, target });
        } catch (/** @type {unknown} */ err) {
            const internalMessage =
                err instanceof Object && err !== null && "message" in err
                    ? String(err.message)
                    : String(err);

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
 * Transcribe all files in a directory.
 * Intermediate transcription files are written to a temporary OS directory,
 * then stored atomically in the temporary database before being cleaned up.
 * The request is marked done in the temporary database upon completion.
 *
 * @param {Capabilities} capabilities
 * @param {string} inputDir
 * @param {import('./request_identifier').RequestIdentifier} reqId
 * @returns {Promise<TranscriptionStatus>}
 */
async function transcribeAllRequest(capabilities, inputDir, reqId) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "volodyslav-transcribe-"));
    try {
        const result = await transcribeAllDirectory(capabilities, inputDir, tmpDir);

        // Store successful transcription outputs in the temporary database atomically.
        for (const success of result.successes) {
            const filename = path.basename(success.target.path);
            const data = await fs.readFile(success.target.path);
            await capabilities.temporary.storeBlob(reqId, filename, data);
        }

        await capabilities.temporary.markDone(reqId);
        return result;
    } finally {
        await fs.rm(tmpDir, { recursive: true }).catch(() => {});
    }
}

module.exports = {
    InputDirectoryAccess,
    transcribeAllGeneric,
    transcribeAllDirectory,
    transcribeAllRequest,
};
