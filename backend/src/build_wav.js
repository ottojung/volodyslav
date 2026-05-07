/**
 * Shared WAV-encoding utility.
 *
 * Extracted here to avoid circular dependencies between
 * audio_recording_session (which finalizes sessions as WAV) and
 * live_diary (which also builds WAV for transcription).
 *
 * @module build_wav
 */

class WavAssemblyInvariantError extends Error {
    /**
     * @param {string} message
     */
    constructor(message) {
        super(message);
        this.name = "WavAssemblyInvariantError";
    }
}

/**
 * @param {unknown} object
 * @returns {object is WavAssemblyInvariantError}
 */
function isWavAssemblyInvariantError(object) {
    return object instanceof WavAssemblyInvariantError;
}

/**
 * Wrap raw PCM bytes in a 44-byte RIFF/PCM WAV header.
 *
 * @param {Buffer} pcm - Raw signed little-endian PCM samples.
 * @param {number} sampleRate - Sample rate in Hz (e.g. 16000).
 * @param {number} channels - Number of channels (e.g. 1 for mono).
 * @param {number} bitDepth - Bits per sample (e.g. 16).
 * @returns {Buffer}
 */
function buildWavFromPcm(pcm, sampleRate, channels, bitDepth) {
    const bytesPerSample = bitDepth / 8;
    const dataSize = pcm.length;
    const buf = Buffer.allocUnsafe(44 + dataSize);
    buf.write("RIFF", 0, "ascii");
    buf.writeUInt32LE(36 + dataSize, 4);
    buf.write("WAVE", 8, "ascii");
    buf.write("fmt ", 12, "ascii");
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(channels, 22);
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
    buf.writeUInt16LE(channels * bytesPerSample, 32);
    buf.writeUInt16LE(bitDepth, 34);
    buf.write("data", 36, "ascii");
    buf.writeUInt32LE(dataSize, 40);
    pcm.copy(buf, 44);
    return buf;
}

/**
 * Build a WAV from session chunk sublevel content.
 *
 * Reads chunk keys in lexical order, computes total PCM bytes,
 * then assembles the final WAV in one contiguous allocation.
 *
 * @param {{ listKeys: () => Promise<import('./temporary/database/types').TempKey[]>, get: (key: import('./temporary/database/types').TempKey) => Promise<Buffer|undefined> }} sessionChunks
 * @param {number} sampleRate
 * @param {number} channels
 * @param {number} bitDepth
 * @returns {Promise<Buffer>}
 */
async function buildWav(sessionChunks, sampleRate, channels, bitDepth) {
    const chunkKeys = await sessionChunks.listKeys();
    chunkKeys.sort((a, b) => String(a).localeCompare(String(b)));

    let totalPcmBytes = 0;
    for (const key of chunkKeys) {
        const entry = await sessionChunks.get(key);
        if (entry !== undefined) {
            totalPcmBytes += entry.length;
        }
    }

    const finalBuffer = Buffer.allocUnsafe(44 + totalPcmBytes);
    finalBuffer.write("RIFF", 0, "ascii");
    finalBuffer.writeUInt32LE(36 + totalPcmBytes, 4);
    finalBuffer.write("WAVE", 8, "ascii");
    finalBuffer.write("fmt ", 12, "ascii");
    finalBuffer.writeUInt32LE(16, 16);
    finalBuffer.writeUInt16LE(1, 20);
    finalBuffer.writeUInt16LE(channels, 22);
    finalBuffer.writeUInt32LE(sampleRate, 24);
    finalBuffer.writeUInt32LE(sampleRate * channels * (bitDepth / 8), 28);
    finalBuffer.writeUInt16LE(channels * (bitDepth / 8), 32);
    finalBuffer.writeUInt16LE(bitDepth, 34);
    finalBuffer.write("data", 36, "ascii");
    finalBuffer.writeUInt32LE(totalPcmBytes, 40);

    let offset = 44;
    for (const key of chunkKeys) {
        const entry = await sessionChunks.get(key);
        if (entry !== undefined) {
            entry.copy(finalBuffer, offset);
            offset += entry.length;
        }
    }

    if (offset !== finalBuffer.length) {
        throw new WavAssemblyInvariantError(
            `WAV assembly invariant failed: expected offset ${finalBuffer.length}, got ${offset}`
        );
    }

    return finalBuffer;
}

module.exports = { buildWav, buildWavFromPcm, WavAssemblyInvariantError, isWavAssemblyInvariantError };
