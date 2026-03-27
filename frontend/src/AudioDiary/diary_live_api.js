/**
 * API client for live diary questioning backend endpoints.
 *
 * @module diary_live_api
 */

import { API_BASE_URL } from "../api_base_url.js";

const DIARY_LIVE_BASE = `${API_BASE_URL}/diary/live`;

/**
 * @typedef {object} DiaryQuestion
 * @property {string} text
 * @property {"warm_reflective" | "clarifying" | "forward"} intent
 */

/**
 * @typedef {object} PushAudioParams
 * @property {Blob} audioBlob - 10-second audio fragment.
 * @property {string} mimeType - MIME type of the audio.
 * @property {string} sessionId - Recording session identifier.
 * @property {number} fragmentNumber - Fragment sequence number (1-based).
 */

/**
 * @typedef {object} PushAudioResult
 * @property {DiaryQuestion[]} questions - New diary questions (may be empty).
 */

/**
 * Push a 10-second audio fragment to the server.
 * The server accumulates fragments, transcribes 20-second windows, recombines
 * overlapping transcripts, and generates diary questions internally.
 * @param {PushAudioParams} params
 * @returns {Promise<PushAudioResult>}
 */
export async function pushAudio(params) {
    const { audioBlob, mimeType, sessionId, fragmentNumber } = params;

    const formData = new FormData();
    formData.append("audio", audioBlob, `fragment.${extensionForMime(mimeType)}`);
    formData.append("mimeType", mimeType);
    formData.append("sessionId", sessionId);
    formData.append("fragmentNumber", String(fragmentNumber));

    const response = await fetch(`${DIARY_LIVE_BASE}/push-audio`, {
        method: "POST",
        body: formData,
    });

    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Push audio request failed: ${response.status}`);
    }

    const data = await response.json();
    if (!data.success) {
        throw new Error(data.error || "Push audio request failed");
    }

    return { questions: data.questions };
}

/** @type {Record<string, string>} */
const MIME_EXTENSION_MAP = {
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "audio/wave": "wav",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/flac": "flac",
};

/**
 * Returns the file extension for a MIME type.
 * @param {string} mimeType
 * @returns {string}
 */
function extensionForMime(mimeType) {
    const base = (mimeType.split(";")[0] || "").trim().toLowerCase();
    return MIME_EXTENSION_MAP[base] || "webm";
}
