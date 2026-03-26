/**
 * Shared helpers and constants for the audio recording session module.
 * @module audio_recording_session/helpers
 */

/**
 * Maximum number of fragments (chunks) allowed per session.
 * At 10-second chunks this allows ~2.8 hours of audio.
 */
const MAX_FRAGMENT_COUNT = 1000;

/** @type {RegExp} */
const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * Validate a session ID.
 * @param {string} sessionId
 * @returns {boolean}
 */
function isValidSessionId(sessionId) {
    return SESSION_ID_PATTERN.test(sessionId);
}

/**
 * Derive a file extension from a MIME type string.
 * @param {string} mimeType
 * @returns {string}
 */
function extensionFromMimeType(mimeType) {
    if (mimeType.includes("ogg")) return "ogg";
    if (mimeType.includes("mp4")) return "mp4";
    if (mimeType.includes("weba")) return "weba";
    return "webm";
}

module.exports = {
    MAX_FRAGMENT_COUNT,
    isValidSessionId,
    extensionFromMimeType,
};
