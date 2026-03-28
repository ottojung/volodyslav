/**
 * API client for audio recording session backend endpoints.
 *
 * @module session_api
 */

import { API_BASE_URL } from "../api_base_url.js";

const SESSION_BASE = `${API_BASE_URL}/audio-recording-session`;

/**
 * @typedef {object} SessionInfo
 * @property {string} sessionId
 * @property {'recording'|'stopped'} status
 * @property {string} createdAt
 * @property {number} fragmentCount
 */

/**
 * @typedef {object} SessionState
 * @property {string} sessionId
 * @property {'recording'|'stopped'} status
 * @property {string} mimeType
 * @property {number} elapsedSeconds
 * @property {number} fragmentCount
 * @property {number} lastSequence
 */

/**
 * Thrown by pushAudio when the backend returns 404 (session not found).
 * Callers can detect this to lazily (re-)create the session.
 */
export class PushAudioSessionNotFoundError extends Error {
    /** @param {string} sessionId */
    constructor(sessionId) {
        super(`Session not found during push audio: ${sessionId}`);
        this.name = "PushAudioSessionNotFoundError";
        this.sessionId = sessionId;
    }
}

/**
 * Initialize or touch a recording session.
 * @param {string} sessionId
 * @param {string} mimeType
 * @returns {Promise<SessionInfo>}
 */
export async function startSession(sessionId, mimeType) {
    const response = await fetch(`${SESSION_BASE}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, mimeType }),
    });
    if (!response.ok) {
        throw new Error(`Failed to start session: ${response.status}`);
    }
    const data = await response.json();
    if (!data.success) {
        throw new Error(data.error || "Failed to start session");
    }
    return data.session;
}

/**
 * @typedef {object} DiaryQuestion
 * @property {string} text
 * @property {"warm_reflective" | "clarifying" | "forward"} intent
 */

/**
 * @typedef {'ok' | 'empty_result' | 'degraded_transcription' | 'degraded_question_generation' | 'unsupported_mime' | 'accepted'} PushAudioStatus
 */

/**
 * Push a single audio fragment to the session.
 * @param {string} sessionId
 * @param {{ chunk: Blob, startMs: number, endMs: number, sequence: number, mimeType: string }} params
 * @returns {Promise<{ stored: { sequence: number, filename: string }, session: { fragmentCount: number, lastEndMs: number }, questions: DiaryQuestion[], status: PushAudioStatus }>}
 */
export async function pushAudio(sessionId, { chunk, startMs, endMs, sequence, mimeType }) {
    const formData = new FormData();
    formData.append("audio", chunk, "fragment.webm");
    formData.append("startMs", String(startMs));
    formData.append("endMs", String(endMs));
    formData.append("sequence", String(sequence));
    formData.append("mimeType", mimeType);

    const response = await fetch(`${SESSION_BASE}/${encodeURIComponent(sessionId)}/push-audio`, {
        method: "POST",
        body: formData,
    });
    if (response.status === 404) {
        throw new PushAudioSessionNotFoundError(sessionId);
    }
    if (!response.ok) {
        throw new Error(`Failed to push audio: ${response.status}`);
    }
    const data = await response.json();
    if (!data.success) {
        throw new Error(data.error || "Failed to push audio");
    }
    return {
        stored: data.stored,
        session: data.session,
        questions: data.questions || [],
        status: data.status || "ok",
    };
}

/**
 * Get the current state of a recording session.
 * Returns null if session not found (404).
 * @param {string} sessionId
 * @returns {Promise<SessionState | null>}
 */
export async function getSession(sessionId) {
    const response = await fetch(`${SESSION_BASE}/${encodeURIComponent(sessionId)}`);
    if (response.status === 404) {
        return null;
    }
    if (!response.ok) {
        throw new Error(`Failed to get session: ${response.status}`);
    }
    const data = await response.json();
    if (!data.success) {
        throw new Error(data.error || "Failed to get session");
    }
    return data.session;
}

/**
 * Finalize a recording session (concatenates all chunks).
 * Elapsed duration is computed server-side from the chunk timeline.
 * @param {string} sessionId
 * @returns {Promise<{ status: string, size: number }>}
 */
export async function stopSession(sessionId) {
    const response = await fetch(`${SESSION_BASE}/${encodeURIComponent(sessionId)}/stop`, {
        method: "POST",
    });
    if (!response.ok) {
        throw new Error(`Failed to stop session: ${response.status}`);
    }
    const data = await response.json();
    if (!data.success) {
        throw new Error(data.error || "Failed to stop session");
    }
    return data.session;
}

/**
 * @typedef {object} RestoreState
 * @property {'recording'|'stopped'} status
 * @property {string} mimeType
 * @property {number} elapsedSeconds
 * @property {number} lastSequence
 * @property {boolean} hasFinalAudio
 */

/**
 * Fetch the unified restore payload for a session.
 * Returns null if session not found (404).
 * @param {string} sessionId
 * @returns {Promise<RestoreState | null>}
 */
export async function getSessionRestore(sessionId) {
    const response = await fetch(`${SESSION_BASE}/${encodeURIComponent(sessionId)}/restore`);
    if (response.status === 404) {
        return null;
    }
    if (!response.ok) {
        throw new Error(`Failed to get session restore: ${response.status}`);
    }
    const data = await response.json();
    if (!data.success) {
        throw new Error(data.error || "Failed to get session restore");
    }
    return data.restore;
}

/**
 * Download the final combined audio for a stopped session as a Blob.
 * @param {string} sessionId
 * @returns {Promise<Blob>}
 */
export async function fetchFinalAudio(sessionId) {
    const response = await fetch(`${SESSION_BASE}/${encodeURIComponent(sessionId)}/final-audio`);
    if (!response.ok) {
        throw new Error(`Failed to fetch final audio: ${response.status}`);
    }
    return response.blob();
}

/**
 * Push audio, recreating the session on 404 and retrying once.
 * This ensures the backend workflow recovers when the initial `startSession`
 * call failed transiently.
 *
 * @param {string} sessionId
 * @param {string} fallbackMimeType - used to recreate the session on 404
 * @param {{ chunk: Blob, startMs: number, endMs: number, sequence: number, mimeType: string }} params
 * @returns {Promise<{ questions: DiaryQuestion[], status: PushAudioStatus }>}
 */
export async function pushAudioWithSessionRetry(sessionId, fallbackMimeType, params) {
    let result;
    try {
        result = await pushAudio(sessionId, params);
    } catch (err) {
        if (err instanceof PushAudioSessionNotFoundError) {
            // Session missing (startSession failed earlier) — recreate then retry once.
            await startSession(sessionId, fallbackMimeType || "audio/webm");
            result = await pushAudio(sessionId, params);
        } else {
            throw err;
        }
    }
    return { questions: result.questions, status: result.status };
}

/**
 * Fetch pending live diary questions generated since the last poll.
 * Questions are cleared server-side after being returned (consume-once semantics).
 * Returns an empty array if no questions are available yet.
 * @param {string} sessionId
 * @returns {Promise<DiaryQuestion[]>}
 */
export async function getLiveQuestions(sessionId) {
    const response = await fetch(`${SESSION_BASE}/${encodeURIComponent(sessionId)}/live-questions`);
    if (!response.ok) {
        throw new Error(`Failed to get live questions: ${response.status}`);
    }
    const data = await response.json();
    if (!data.success) {
        throw new Error(data.error || "Failed to get live questions");
    }
    return data.questions || [];
}

/**
 * Delete all data for a session. Best-effort: does not throw on failure.
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
export async function discardSession(sessionId) {
    try {
        await fetch(`${SESSION_BASE}/${encodeURIComponent(sessionId)}`, {
            method: "DELETE",
        });
    } catch {
        // Best-effort: ignore failures
    }
}
