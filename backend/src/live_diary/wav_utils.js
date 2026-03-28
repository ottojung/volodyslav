/**
 * WAV format utilities for PCM-based live diary analysis.
 *
 * WAV parsing is delegated to the `wavefile` library, which handles edge
 * cases, malformed input, and a wide range of WAVE variants reliably.
 * WAV building uses a direct 44-byte RIFF/PCM header write to avoid
 * per-sample boxing that would occur with wavefile's fromScratch() API.
 *
 * @module live_diary/wav_utils
 */

const { WaveFile } = require("wavefile");

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
    try {
        const wf = new WaveFile(buffer);
        // wavefile's fmt/data objects are typed as bare 'object'; use
        // Reflect.get + typeof/instanceof guards to access properties safely.
        const audioFormat = Reflect.get(wf.fmt, "audioFormat");
        if (typeof audioFormat !== "number" || audioFormat !== 1) {
            return null;
        }
        const sampleRate = Reflect.get(wf.fmt, "sampleRate");
        const numChannels = Reflect.get(wf.fmt, "numChannels");
        const bitsPerSample = Reflect.get(wf.fmt, "bitsPerSample");
        if (typeof sampleRate !== "number" || typeof numChannels !== "number" || typeof bitsPerSample !== "number") {
            return null;
        }
        const rawSamples = Reflect.get(wf.data, "samples");
        if (!(rawSamples instanceof Uint8Array)) {
            return null;
        }
        // Only 16-bit PCM is accepted; buildWav interprets raw bytes as
        // 16-bit signed little-endian, so other bit depths would be corrupt.
        if (bitsPerSample !== 16) {
            return null;
        }
        return {
            pcm: Buffer.from(rawSamples),
            sampleRate,
            channels: numChannels,
            bitDepth: bitsPerSample,
        };
    } catch {
        return null;
    }
}

/**
 * Wrap raw PCM data in a RIFF/WAV container.
 *
 * Writes a standard 44-byte PCM WAV header directly into a Buffer and
 * copies the raw sample bytes after it — no per-sample boxing required.
 *
 * @param {Buffer} pcm - Raw PCM sample bytes (16-bit signed LE).
 * @param {number} sampleRate
 * @param {number} channels
 * @param {number} bitDepth - Must be 16.
 * @returns {Buffer}
 */
function buildWav(pcm, sampleRate, channels, bitDepth) {
    const bytesPerSample = bitDepth / 8;
    const dataSize = pcm.length;
    const buf = Buffer.allocUnsafe(44 + dataSize);
    // RIFF descriptor
    buf.write("RIFF", 0, "ascii");
    buf.writeUInt32LE(36 + dataSize, 4);
    buf.write("WAVE", 8, "ascii");
    // "fmt " sub-chunk
    buf.write("fmt ", 12, "ascii");
    buf.writeUInt32LE(16, 16);                                          // Subchunk1Size
    buf.writeUInt16LE(1, 20);                                           // AudioFormat = PCM
    buf.writeUInt16LE(channels, 22);
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);      // ByteRate
    buf.writeUInt16LE(channels * bytesPerSample, 32);                   // BlockAlign
    buf.writeUInt16LE(bitDepth, 34);
    // "data" sub-chunk
    buf.write("data", 36, "ascii");
    buf.writeUInt32LE(dataSize, 40);
    pcm.copy(buf, 44);
    return buf;
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

