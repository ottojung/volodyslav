/**
 * Helper utilities for the live diary pull cycle.
 *
 * Provides `transcribeBuffer` (temp-file transcription) and `loadFragmentPcm`
 * (binary PCM retrieval from the audio-session chunk sublevel).
 *
 * This module is package-private: it must only be imported by `pull_cycle.js`.
 *
 * @module live_diary/pull_helpers
 */

const os = require("os");
const path = require("path");
const fsp = require("fs/promises");
const fs = require("fs");
const crypto = require("crypto");
const { chunksBinarySublevel, chunkKey } = require("../audio_recording_session");
const { extensionForMime } = require("./wav_utils");

/** @typedef {import('../temporary').Temporary} Temporary */
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
    const tmpFile = path.join(os.tmpdir(), `diary-pull-${randomHex}.${ext}`);

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

/**
 * Load the binary PCM for a fragment from the audio-session chunk sublevel.
 * Returns null if the binary is not found (fragment was not persisted via uploadChunk).
 * @param {Temporary} temporary
 * @param {string} sessionId
 * @param {number} sequence
 * @returns {Promise<Buffer | null>}
 */
async function loadFragmentPcm(temporary, sessionId, sequence) {
    const chunks = chunksBinarySublevel(temporary, sessionId);
    const buf = await chunks.get(chunkKey(sequence));
    return buf === undefined ? null : buf;
}

module.exports = {
    transcribeBuffer,
    loadFragmentPcm,
};
