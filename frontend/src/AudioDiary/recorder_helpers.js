/**
 * Pure helper utilities for audio diary recorder.
 *
 * Separated from recorder_logic.js to keep module size manageable.
 *
 * @module recorder_helpers
 */

/**
 * Pick a MIME type supported by the current browser.
 * @returns {string}
 */
export function chooseMimeType() {
    if (
        typeof MediaRecorder === "undefined" ||
        typeof MediaRecorder.isTypeSupported !== "function"
    ) {
        return "";
    }

    const candidates = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
        "audio/ogg",
        "audio/mp4",
        "",
    ];

    for (const mime of candidates) {
        if (mime === "" || MediaRecorder.isTypeSupported(mime)) {
            return mime;
        }
    }

    return "";
}

/**
 * Combine an array of Blobs into one Blob with the given MIME type.
 * @param {Blob[]} chunks
 * @param {string} mimeType
 * @returns {Blob}
 */
export function combineChunks(chunks, mimeType) {
    return new Blob(chunks, { type: mimeType || "audio/webm" });
}
