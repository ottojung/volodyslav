/**
 * Pure helper utilities for the AudioDiary UI component.
 *
 * @module audio_helpers
 */

/** @typedef {'idle' | 'recording' | 'paused' | 'stopped'} RecorderState */

/**
 * Format seconds as mm:ss.
 * @param {number} totalSeconds
 * @returns {string}
 */
export function formatTime(totalSeconds) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Derive a file extension from a MIME type string.
 * @param {string} mimeType
 * @returns {string}
 */
export function extensionForMime(mimeType) {
    if (mimeType.includes("webm")) return "weba";
    if (mimeType.includes("ogg")) return "ogg";
    if (mimeType.includes("mp4")) return "mp4";
    return "weba";
}

/**
 * Builds a request identifier for an audio diary submission.
 * @returns {string}
 */
export function makeDiaryRequestIdentifier() {
    const cryptoObject = globalThis.crypto;
    if (cryptoObject && typeof cryptoObject.randomUUID === "function") {
        return `diary_${cryptoObject.randomUUID().replace(/-/g, "")}`;
    }
    return `diary_${Math.random().toString(36).slice(2, 16)}`;
}

/** @returns {RecorderState} */
export function initialRecorderState() {
    return "idle";
}

/** @returns {Blob | null} */
export function initialAudioBlob() {
    return null;
}

/** @returns {AnalyserNode | null} */
export function initialAnalyser() {
    return null;
}
