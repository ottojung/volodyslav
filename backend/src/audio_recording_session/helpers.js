/**
 * Shared helpers and constants for the audio recording session module.
 * @module audio_recording_session/helpers
 */

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

/**
 * Validate and normalize an audio MIME type string.
 * Accepts only audio/* types; strips parameter suffixes (e.g., "; codecs=vp9").
 * Returns the normalized type string, or null if invalid.
 * @param {unknown} mimeType
 * @returns {string | null}
 */
function parseAudioMimeType(mimeType) {
    if (typeof mimeType !== "string" || !mimeType) {
        return null;
    }
    // Strip parameters (everything after the first semicolon) and normalize case.
    const base = (mimeType.split(";")[0] || "").trim().toLowerCase();
    const match = /^audio\/([^\s;]+)$/.exec(base);
    if (!match) {
        return null;
    }
    return `audio/${match[1]}`;
}

module.exports = {
    isValidSessionId,
    extensionFromMimeType,
    parseAudioMimeType,
};
