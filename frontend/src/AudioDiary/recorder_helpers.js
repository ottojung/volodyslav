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
 * If mimeType is empty, derives it from the first chunk's type,
 * and only falls back to "audio/webm" when that is also unavailable.
 * @param {Blob[]} chunks
 * @param {string} mimeType
 * @returns {Blob}
 */
export function combineChunks(chunks, mimeType) {
    let finalType = mimeType;

    if (!finalType && chunks.length > 0) {
        const firstChunk = chunks[0];
        if (firstChunk && typeof firstChunk.type === "string" && firstChunk.type) {
            finalType = firstChunk.type;
        }
    }

    if (!finalType) {
        finalType = "audio/webm";
    }

    return new Blob(chunks, { type: finalType });
}
