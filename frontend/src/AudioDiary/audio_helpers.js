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
    if (mimeType.includes("ogg")) return "ogg";
    if (mimeType.includes("mp4")) return "mp4";
    if (mimeType.includes("weba")) return "weba";
    return "webm";
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

/**
 * Generate a unique session ID using crypto.randomUUID() if available,
 * or a crypto.getRandomValues()-based fallback.
 * @returns {string}
 */
export function generateSessionId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    }
    throw new Error("No secure random source available");
}
