/**
 * Shared transcription helper for the live diary pipeline.
 *
 * Used by both the legacy eager pipeline (`service.js`) and the lazy pull
 * pipeline (`pull_helpers.js`) so the implementation stays in one place.
 *
 * @module live_diary/transcribe_utils
 */

const os = require("os");
const path = require("path");
const fsp = require("fs/promises");
const fs = require("fs");
const crypto = require("crypto");
const { extensionForMime } = require("./wav_utils");

/** @typedef {import('../ai/transcription').AITranscription} AITranscription */
/** @typedef {import('../logger').Logger} Logger */

/**
 * @typedef {object} TranscribeCapabilities
 * @property {AITranscription} aiTranscription
 * @property {Logger} logger
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
    const randomHex = crypto.randomBytes(8).toString("hex");
    const tmpFile = path.join(os.tmpdir(), `diary-${randomHex}.${ext}`);

    try {
        await fsp.writeFile(tmpFile, audioBuffer);

        const fileStream = fs.createReadStream(tmpFile);

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
        fsp.unlink(tmpFile).catch(() => {
            // Best-effort cleanup.
        });
    }
}

module.exports = {
    transcribeBuffer,
};
