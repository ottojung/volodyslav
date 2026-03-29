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

/**
 * Validate raw PCM format parameters: sampleRateHz, channels, bitDepth, and buffer shape.
 * Returns null on success, or an error message string describing the first violation.
 *
 * @param {unknown} pcm
 * @param {unknown} sampleRateHz
 * @param {unknown} channels
 * @param {unknown} bitDepth
 * @returns {string | null}
 */
function validatePcmParams(pcm, sampleRateHz, channels, bitDepth) {
    if (!Buffer.isBuffer(pcm)) {
        return "Invalid pcm: must be a Buffer";
    }
    if (typeof sampleRateHz !== "number" || !Number.isInteger(sampleRateHz) || sampleRateHz <= 0) {
        return `Invalid sampleRateHz: must be a positive integer, got ${sampleRateHz}`;
    }
    if (typeof channels !== "number" || !Number.isInteger(channels) || channels <= 0) {
        return `Invalid channels: must be a positive integer, got ${channels}`;
    }
    if (bitDepth !== 16) {
        return `Invalid bitDepth: only 16 is supported, got ${bitDepth}`;
    }
    const bytesPerFrame = channels * (bitDepth / 8);
    if (pcm.length % bytesPerFrame !== 0) {
        return `Invalid pcm: byte length ${pcm.length} is not aligned to frame size ${bytesPerFrame}`;
    }
    return null;
}

/**
 * Validate a complete PCM chunk upload: sequence, timing, buffer, and format.
 * Returns null on success, or an error message string describing the first violation.
 *
 * @param {{ pcm: unknown, sampleRateHz: unknown, channels: unknown, bitDepth: unknown, startMs: unknown, endMs: unknown, sequence: unknown }} params
 * @returns {string | null}
 */
function validateUploadChunkParams(params) {
    const { pcm, sampleRateHz, channels, bitDepth, startMs, endMs, sequence } = params;
    if (typeof sequence !== "number" || !Number.isInteger(sequence) || sequence < 0 || sequence > 999999) {
        return `Invalid sequence: must be a non-negative integer not exceeding 999999, got ${sequence}`;
    }
    if (typeof startMs !== "number" || !Number.isFinite(startMs) || startMs < 0) {
        return `Invalid startMs: must be a non-negative finite number, got ${startMs}`;
    }
    if (typeof endMs !== "number" || !Number.isFinite(endMs) || endMs < startMs) {
        return `Invalid endMs: must be >= startMs (${startMs}), got ${endMs}`;
    }
    return validatePcmParams(pcm, sampleRateHz, channels, bitDepth);
}

module.exports = {
    isValidSessionId,
    extensionFromMimeType,
    parseAudioMimeType,
    validatePcmParams,
    validateUploadChunkParams,
    /** Matches unsigned integers 0–999999 (for sequence numbers). */
    UINT_RE: /^\d{1,6}$/,
    /** Matches unsigned floats (for startMs/endMs). */
    UFLOAT_RE: /^\d+(\.\d+)?$/,
    /** Matches positive integers 1–999999 (for sampleRateHz, channels, bitDepth). */
    POSINT_RE: /^[1-9]\d{0,5}$/,
};
