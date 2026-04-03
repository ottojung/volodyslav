/**
 * Helper utilities for the live diary pull cycle.
 *
 * Provides `loadFragmentPcm` (binary PCM retrieval from the audio-session chunk
 * sublevel) and re-exports `transcribeBuffer` from `transcribe_utils.js`.
 *
 * This module is package-private: it must only be imported by `pull_cycle.js`.
 *
 * @module live_diary/pull_helpers
 */

const { chunksBinarySublevel, chunkKey } = require("../audio_recording_session");
const { transcribeBuffer } = require("./transcribe_utils");

/** @typedef {import('../temporary').Temporary} Temporary */

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
