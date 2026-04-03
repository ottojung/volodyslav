/**
 * Shared transcription helper for the live diary pipeline.
 *
 * Used by both the legacy eager pipeline (`service.js`) and the lazy pull
 * pipeline (`pull_helpers.js`) so the implementation stays in one place.
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
 * Write a Buffer to a named temp file, transcribe it, then delete the temp file.
 * Returns the raw transcript string (trimmed).
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
    } finally {
        capabilities.deleter.deleteDirectory(tmpDir).catch(() => {
            // Best-effort cleanup.
        });
    }
}

module.exports = {
    transcribeBuffer,
};
