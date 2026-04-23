/**
 * Shared transcription helper for the live diary pull pipeline.
 *
 * Used by the pull pipeline (`pull_helpers.js`) so the implementation stays
 * in one place.
 *
 * File I/O is performed through the capabilities pattern (creator / writer /
 * reader / deleter) so that the helper is testable without touching the real
 * filesystem.
 *
 * @module live_diary/transcribe_utils
 */

const path = require("path");
const { extensionForMime } = require("./wav_utils");

/** @typedef {import('../ai/transcription').AITranscription} AITranscription */
/** @typedef {import('../logger').Logger} Logger */
/** @typedef {import('../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('../filesystem/reader').FileReader} FileReader */
/** @typedef {import('../filesystem/deleter').FileDeleter} FileDeleter */

/**
 * @typedef {object} TranscribeCapabilities
 * @property {AITranscription} aiTranscription
 * @property {Logger} logger
 * @property {FileCreator} creator
 * @property {FileWriter} writer
 * @property {FileReader} reader
 * @property {FileDeleter} deleter
 */

/**
 * Open a file stream for `tmpFile` and transcribe it using the AI capability.
 * The file stream is destroyed after the call (success or failure).
 *
 * Keeping this in a separate function ensures that `audioBuffer` (held by the
 * outer `transcribeBuffer` frame) can be reclaimed by V8's GC before the
 * network request starts: once `transcribeBuffer` awaits this helper, `audioBuffer`
 * is no longer reachable from any live frame inside this function.
 *
 * @param {string} tmpFile - Path to the audio file to transcribe.
 * @param {TranscribeCapabilities} capabilities
 * @returns {Promise<string>} Trimmed transcript text.
 */
async function _transcribeFromFile(tmpFile, capabilities) {
    const fileStream = capabilities.reader.createReadStream(tmpFile);

    await new Promise((resolve, reject) => {
        fileStream.once("open", resolve);
        fileStream.once("error", reject);
    });

    let result;
    try {
        result = await capabilities.aiTranscription.transcribeStreamPreciseDetailed(fileStream);
    } finally {
        fileStream.destroy();
    }

    return result.structured.transcript.trim();
}

/**
 * Write a Buffer to a named temp file, transcribe it, then delete the temp file.
 * Returns the raw transcript string (trimmed).
 *
 * Memory note: `audioBuffer` is only needed until it has been written to disk.
 * After `writeBuffer` completes, this function awaits `_transcribeFromFile`
 * which has no reference to `audioBuffer`, allowing V8 to reclaim the buffer
 * before the network request to the AI provider is made.
 *
 * @param {Buffer} audioBuffer
 * @param {string} mimeType
 * @param {TranscribeCapabilities} capabilities
 * @returns {Promise<string>}
 */
async function transcribeBuffer(audioBuffer, mimeType, capabilities) {
    const ext = extensionForMime(mimeType);
    const tmpDir = await capabilities.creator.createTemporaryDirectory();

    try {
        const tmpFile = await capabilities.creator.createFile(
            path.join(tmpDir, `diary.${ext}`)
        );
        await capabilities.writer.writeBuffer(tmpFile, audioBuffer);

        // `audioBuffer` is no longer needed beyond this point.  The helper
        // function below holds no reference to it, so V8 can reclaim the
        // buffer while the (potentially long-running) network request is
        // in flight.
        return await _transcribeFromFile(tmpFile, capabilities);
    } finally {
        capabilities.deleter.deleteDirectory(tmpDir).catch(() => {
            // Best-effort cleanup.
        });
    }
}

module.exports = {
    transcribeBuffer,
};
