/**
 * API client for live diary questioning backend endpoints.
 *
 * @module diary_live_api
 */

import { API_BASE_URL } from "../api_base_url.js";

const DIARY_LIVE_BASE = `${API_BASE_URL}/diary/live`;

/**
 * @typedef {object} TranscriptToken
 * @property {string} text
 * @property {number} startMs
 * @property {number} endMs
 */

/**
 * @typedef {object} TranscribeWindowResult
 * @property {number} milestoneNumber
 * @property {number} windowStartMs
 * @property {number} windowEndMs
 * @property {TranscriptToken[]} tokens
 * @property {string} rawText
 */

/**
 * @typedef {object} DiaryQuestion
 * @property {string} text
 * @property {"warm_reflective" | "clarifying" | "forward"} intent
 */

/**
 * @typedef {object} GenerateQuestionsResult
 * @property {number} milestoneNumber
 * @property {DiaryQuestion[]} questions
 */

/**
 * @typedef {object} TranscribeWindowParams
 * @property {Blob} audioBlob - Combined audio for the window.
 * @property {string} mimeType - MIME type of the audio.
 * @property {string} sessionId - Recording session identifier.
 * @property {number} milestoneNumber - Milestone sequence number (1-based).
 * @property {number} windowStartMs - Window start time (ms from recording start).
 * @property {number} windowEndMs - Window end time (ms from recording start).
 */

/**
 * @typedef {object} GenerateQuestionsParams
 * @property {string} sessionId - Recording session identifier.
 * @property {number} milestoneNumber - Milestone sequence number.
 * @property {string} transcriptSoFar - Full merged transcript text.
 * @property {string[]} askedQuestions - All previously asked question texts.
 */

/**
 * Submit a 20-second audio window for live transcription.
 * @param {TranscribeWindowParams} params
 * @returns {Promise<TranscribeWindowResult>}
 */
export async function transcribeWindow(params) {
    const { audioBlob, mimeType, sessionId, milestoneNumber, windowStartMs, windowEndMs } = params;

    const formData = new FormData();
    formData.append("audio", audioBlob, `window.${extensionForMime(mimeType)}`);
    formData.append("mimeType", mimeType);
    formData.append("sessionId", sessionId);
    formData.append("milestoneNumber", String(milestoneNumber));
    formData.append("windowStartMs", String(windowStartMs));
    formData.append("windowEndMs", String(windowEndMs));

    const response = await fetch(`${DIARY_LIVE_BASE}/transcribe-window`, {
        method: "POST",
        body: formData,
    });

    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Transcription request failed: ${response.status}`);
    }

    const data = await response.json();
    if (!data.success) {
        throw new Error(data.error || "Transcription request failed");
    }

    return {
        milestoneNumber: data.milestoneNumber,
        windowStartMs: data.windowStartMs,
        windowEndMs: data.windowEndMs,
        tokens: data.tokens,
        rawText: data.rawText,
    };
}

/**
 * Request live diary questions based on the current transcript.
 * @param {GenerateQuestionsParams} params
 * @returns {Promise<GenerateQuestionsResult>}
 */
export async function generateQuestions(params) {
    const { sessionId, milestoneNumber, transcriptSoFar, askedQuestions } = params;

    const response = await fetch(`${DIARY_LIVE_BASE}/generate-questions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, milestoneNumber, transcriptSoFar, askedQuestions }),
    });

    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Question generation request failed: ${response.status}`);
    }

    const data = await response.json();
    if (!data.success) {
        throw new Error(data.error || "Question generation request failed");
    }

    return {
        milestoneNumber: data.milestoneNumber,
        questions: data.questions,
    };
}

/**
 * @typedef {object} RecombineOverlapParams
 * @property {string} sessionId - Recording session identifier.
 * @property {string} existingOverlapText - Existing transcript text covering the overlap zone.
 * @property {string} newWindowText - New window transcript text.
 */

/**
 * @typedef {object} RecombineOverlapResult
 * @property {string} recombinedText - The LLM-merged transcript text.
 */

/**
 * Ask the backend to recombine two overlapping transcript segments using an LLM.
 * @param {RecombineOverlapParams} params
 * @returns {Promise<RecombineOverlapResult>}
 */
export async function recombineOverlap(params) {
    const { sessionId, existingOverlapText, newWindowText } = params;

    const response = await fetch(`${DIARY_LIVE_BASE}/recombine-overlap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, existingOverlapText, newWindowText }),
    });

    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Recombination request failed: ${response.status}`);
    }

    const data = await response.json();
    if (!data.success) {
        throw new Error(data.error || "Recombination request failed");
    }

    return { recombinedText: data.recombinedText };
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
