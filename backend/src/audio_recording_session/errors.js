/**
 * Error classes for the audio recording session feature.
 * @module audio_recording_session/errors
 */

/**
 * Thrown when an audio session is not found in temporary storage.
 */
class AudioSessionNotFoundError extends Error {
    /**
     * @param {string} sessionId
     */
    constructor(sessionId) {
        super(`Audio session not found: ${sessionId}`);
        this.name = "AudioSessionNotFoundError";
        this.sessionId = sessionId;
    }
}

/**
 * @param {unknown} object
 * @returns {object is AudioSessionNotFoundError}
 */
function isAudioSessionNotFoundError(object) {
    return object instanceof AudioSessionNotFoundError;
}

/**
 * Thrown when a chunk upload or session operation receives invalid input.
 */
class AudioSessionChunkValidationError extends Error {
    /**
     * @param {string} message
     */
    constructor(message) {
        super(message);
        this.name = "AudioSessionChunkValidationError";
    }
}

/**
 * @param {unknown} object
 * @returns {object is AudioSessionChunkValidationError}
 */
function isAudioSessionChunkValidationError(object) {
    return object instanceof AudioSessionChunkValidationError;
}

/**
 * Thrown when a session operation conflicts with the current session state
 * (e.g., uploading to a finalized session).
 */
class AudioSessionConflictError extends Error {
    /**
     * @param {string} message
     * @param {string} sessionId
     */
    constructor(message, sessionId) {
        super(message);
        this.name = "AudioSessionConflictError";
        this.sessionId = sessionId;
    }
}

/**
 * @param {unknown} object
 * @returns {object is AudioSessionConflictError}
 */
function isAudioSessionConflictError(object) {
    return object instanceof AudioSessionConflictError;
}

/**
 * Thrown when finalization (stop + concat) fails.
 */
class AudioSessionFinalizeError extends Error {
    /**
     * @param {string} message
     * @param {string} sessionId
     * @param {unknown} [cause]
     */
    constructor(message, sessionId, cause) {
        super(message);
        this.name = "AudioSessionFinalizeError";
        this.sessionId = sessionId;
        this.cause = cause;
    }
}

/**
 * @param {unknown} object
 * @returns {object is AudioSessionFinalizeError}
 */
function isAudioSessionFinalizeError(object) {
    return object instanceof AudioSessionFinalizeError;
}

module.exports = {
    AudioSessionNotFoundError,
    isAudioSessionNotFoundError,
    AudioSessionChunkValidationError,
    isAudioSessionChunkValidationError,
    AudioSessionConflictError,
    isAudioSessionConflictError,
    AudioSessionFinalizeError,
    isAudioSessionFinalizeError,
};
