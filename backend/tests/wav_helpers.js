/**
 * Shared WAV fixture helpers for backend tests.
 */

/**
 * Build a minimal valid WAV buffer for backend tests.
 * PCM payload is silence and suitable for mocked transcription flows.
 * @returns {Buffer} A minimal 16kHz mono WAV buffer with silent PCM payload.
 */
function buildTestWavBuffer() {
    const sampleRate = 16000;
    const numSamples = 8;
    const pcm = Buffer.alloc(numSamples * 2);
    const header = Buffer.alloc(44);
    header.write("RIFF", 0, "ascii");
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write("WAVE", 8, "ascii");
    header.write("fmt ", 12, "ascii");
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36, "ascii");
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
}

module.exports = { buildTestWavBuffer };
