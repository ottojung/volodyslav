/**
 * WAV format utilities for PCM-based live diary analysis.
 *
 * These helpers parse and build RIFF/WAV files with PCM audio data.
 * Used by the live diary service to safely concatenate two 10-second
 * PCM fragments into a 20-second overlap window without the structural
 * fragility of raw WebM concatenation.
 *
 * @module live_diary/wav_utils
 */

/**
 * @typedef {object} WavInfo
 * @property {Buffer} pcm - Raw PCM sample bytes.
 * @property {number} sampleRate - Samples per second.
 * @property {number} channels - Number of audio channels.
 * @property {number} bitDepth - Bits per sample (e.g. 16).
 */

/**
 * Parse a RIFF/WAV buffer and extract PCM payload + format metadata.
 *
 * Only PCM (audio format 1) is accepted.  Returns null for any input
 * that cannot be parsed as a valid PCM WAV file.
 *
 * @param {Buffer} buffer
 * @returns {WavInfo | null}
 */
function parseWav(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 44) {
        return null;
    }

    if (buffer.toString("ascii", 0, 4) !== "RIFF") {
        return null;
    }
    if (buffer.toString("ascii", 8, 12) !== "WAVE") {
        return null;
    }

    let sampleRate = 0;
    let channels = 0;
    let bitDepth = 0;
    let dataOffset = -1;
    let dataSize = -1;

    let offset = 12;
    while (offset + 8 <= buffer.length) {
        const chunkId = buffer.toString("ascii", offset, offset + 4);
        const chunkSize = buffer.readUInt32LE(offset + 4);

        if (chunkId === "fmt ") {
            if (chunkSize < 16) {
                return null;
            }
            const audioFormat = buffer.readUInt16LE(offset + 8);
            if (audioFormat !== 1) {
                // Not linear PCM — reject.
                return null;
            }
            channels = buffer.readUInt16LE(offset + 10);
            sampleRate = buffer.readUInt32LE(offset + 12);
            bitDepth = buffer.readUInt16LE(offset + 22);
        } else if (chunkId === "data") {
            dataOffset = offset + 8;
            dataSize = chunkSize;
            break;
        }

        offset += 8 + chunkSize;
        // RIFF chunks are padded to even byte boundaries.
        if (chunkSize % 2 !== 0) {
            offset += 1;
        }
    }

    if (sampleRate === 0 || channels === 0 || bitDepth === 0 || dataOffset < 0 || dataSize < 0) {
        return null;
    }

    // Clamp to actual buffer length in case the reported dataSize is larger.
    const pcmEnd = Math.min(dataOffset + dataSize, buffer.length);
    const pcm = buffer.slice(dataOffset, pcmEnd);

    return { pcm, sampleRate, channels, bitDepth };
}

/**
 * Wrap raw PCM data in a RIFF/WAV container.
 *
 * @param {Buffer} pcm - Raw PCM sample bytes.
 * @param {number} sampleRate
 * @param {number} channels
 * @param {number} bitDepth
 * @returns {Buffer}
 */
function buildWav(pcm, sampleRate, channels, bitDepth) {
    const blockAlign = channels * Math.ceil(bitDepth / 8);
    const byteRate = sampleRate * blockAlign;
    const dataSize = pcm.length;

    const header = Buffer.allocUnsafe(44);
    header.write("RIFF", 0, "ascii");
    header.writeUInt32LE(36 + dataSize, 4);
    header.write("WAVE", 8, "ascii");
    header.write("fmt ", 12, "ascii");
    header.writeUInt32LE(16, 16);       // fmt chunk size
    header.writeUInt16LE(1, 20);        // PCM format
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitDepth, 34);
    header.write("data", 36, "ascii");
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcm]);
}

/** Supported audio MIME types and their file extensions. */
/** @type {Record<string, string>} */
const EXTENSION_BY_MIME = {
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "audio/wave": "wav",
    "audio/x-wav": "wav",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/flac": "flac",
};

/**
 * Returns the file extension for a MIME type, defaulting to "webm".
 * @param {string} mimeType
 * @returns {string}
 */
function extensionForMime(mimeType) {
    const base = normalizeMimeType(mimeType);
    return EXTENSION_BY_MIME[base] || "webm";
}

/**
 * Normalize a MIME type to its lowercased base form (without parameters).
 * @param {string} mimeType
 * @returns {string}
 */
function normalizeMimeType(mimeType) {
    return (mimeType.split(";")[0] || "").trim().toLowerCase();
}

module.exports = { parseWav, buildWav, extensionForMime, normalizeMimeType };