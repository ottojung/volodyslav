/**
 * Shared WAV-encoding utility.
 *
 * Creates a RIFF/PCM WAV buffer from raw PCM bytes.
 * Extracted here to avoid circular dependencies between
 * audio_recording_session (which finalizes sessions as WAV) and
 * live_diary (which also builds WAV for transcription).
 *
 * @module build_wav
 */

/**
 * Wrap raw PCM bytes in a 44-byte RIFF/PCM WAV header.
 *
 * @param {Buffer} pcm - Raw signed little-endian PCM samples.
 * @param {number} sampleRate - Sample rate in Hz (e.g. 16000).
 * @param {number} channels - Number of channels (e.g. 1 for mono).
 * @param {number} bitDepth - Bits per sample (e.g. 16).
 * @returns {Buffer}
 */
function buildWav(pcm, sampleRate, channels, bitDepth) {
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

module.exports = { buildWav };
