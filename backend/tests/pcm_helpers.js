/**
 * Shared PCM fixture helpers for backend tests.
 */

/**
 * Build a minimal valid raw PCM buffer for backend tests.
 * 8 silent 16-bit samples at 16kHz mono.
 * @returns {Buffer}
 */
function buildTestPcmBuffer() {
    return Buffer.from(new Int16Array(8).buffer);
}

/**
 * Default PCM format used in tests.
 * @type {{ sampleRateHz: number, channels: number, bitDepth: number }}
 */
const TEST_PCM_FORMAT = {
    sampleRateHz: 16000,
    channels: 1,
    bitDepth: 16,
};

module.exports = { buildTestPcmBuffer, TEST_PCM_FORMAT };
