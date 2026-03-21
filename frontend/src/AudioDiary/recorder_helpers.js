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

/**
 * Extract a readable message from a MediaRecorder error event payload.
 * @param {unknown} error
 * @returns {string}
 */
export function mediaRecorderErrorMessage(error) {
    let message = "Unknown MediaRecorder error";
    if (typeof ErrorEvent !== "undefined" && error instanceof ErrorEvent) {
        return error.message || message;
    }
    if (error && typeof error === "object") {
        const inner = "error" in error ? error.error : null;
        const extracted =
            inner instanceof Error
                ? inner.message
                : inner &&
                    typeof inner === "object" &&
                    "message" in inner &&
                    typeof inner.message === "string"
                  ? inner.message
                : inner != null
                  ? String(inner)
                  : ("message" in error && typeof error.message === "string"
                      ? error.message
                      : "name" in error && typeof error.name === "string"
                        ? error.name
                        : null);
        if (extracted) {
            message = extracted;
        }
    } else if (error != null) {
        message = String(error);
    }
    return message;
}
