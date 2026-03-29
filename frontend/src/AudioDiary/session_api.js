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
 * Thrown by pushPcm when the backend returns 404 (session not found).
 * Callers can detect this to lazily (re-)create the session.
 */
export class PushPcmSessionNotFoundError extends Error {
    /** @param {string} sessionId */
    constructor(sessionId) {
        super(`Session not found during push PCM: ${sessionId}`);
        this.name = "PushPcmSessionNotFoundError";
        this.sessionId = sessionId;
    }
}

/**
 * Thrown by pushPcm when the backend returns a 5xx server error.
 * This typically indicates a transient proxy or infrastructure issue
 * (e.g., nginx body-buffering failure) and is safe to retry.
 */
export class PushPcmServerError extends Error {
    /** @param {number} status */
    constructor(status) {
        super(`Server error pushing PCM: ${status}`);
        this.name = "PushPcmServerError";
        this.status = status;
    }
}

/**
 * Initialize or touch a recording session.
 * @param {string} sessionId
 * @returns {Promise<SessionInfo>}
 */
export async function startSession(sessionId) {
    const response = await fetch(`${SESSION_BASE}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
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
 * @typedef {'accepted'} PushPcmStatus
 */

/**
 * Push a single raw PCM fragment to the session.
 * @param {string} sessionId
 * @param {{ pcmBytes: ArrayBuffer, sampleRateHz: number, channels: number, bitDepth: number, startMs: number, endMs: number, sequence: number }} params
 * @returns {Promise<{ stored: { sequence: number, filename: string }, session: { fragmentCount: number, lastEndMs: number }, status: PushPcmStatus }>}
 */
export async function pushPcm(sessionId, { pcmBytes, sampleRateHz, channels, bitDepth, startMs, endMs, sequence }) {
    const formData = new FormData();
    formData.append("pcm", new Blob([pcmBytes], { type: "application/octet-stream" }), "fragment.pcm");
    formData.append("startMs", String(startMs));
    formData.append("endMs", String(endMs));
    formData.append("sequence", String(sequence));
    formData.append("sampleRateHz", String(sampleRateHz));
    formData.append("channels", String(channels));
    formData.append("bitDepth", String(bitDepth));

    const response = await fetch(`${SESSION_BASE}/${encodeURIComponent(sessionId)}/push-pcm`, {
        method: "POST",
        body: formData,
    });
    if (response.status === 404) {
        throw new PushPcmSessionNotFoundError(sessionId);
    }
    if (response.status >= 500) {
        throw new PushPcmServerError(response.status);
    }
    if (!response.ok) {
        throw new Error(`Failed to push PCM: ${response.status}`);
    }
    const data = await response.json();
    if (!data.success) {
        throw new Error(data.error || "Failed to push PCM");
    }
    return {
        stored: data.stored,
        session: data.session,
        status: data.status,
    };
}

/**
 * Push PCM, recreating the session on 404 and retrying up to
 * MAX_SERVER_RETRIES times on transient server errors (5xx).
 *
 * Session recreation handles the case where the initial `startSession`
 * call failed transiently.  Server-error retries handle transient proxy
 * issues such as nginx failing to buffer the request body to disk.
 *
 * @param {string} sessionId
 * @param {{ pcmBytes: ArrayBuffer, sampleRateHz: number, channels: number, bitDepth: number, startMs: number, endMs: number, sequence: number }} params
 * @returns {Promise<{ status: PushPcmStatus }>}
 */
export async function pushPcmWithSessionRetry(sessionId, params) {
    const MAX_SERVER_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_SERVER_RETRIES; attempt++) {
        if (attempt > 0) {
            // Brief wait before retrying after a server error.
            await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        }
        let result;
        try {
            result = await pushPcm(sessionId, params);
        } catch (err) {
            if (err instanceof PushPcmSessionNotFoundError) {
                // Session missing (startSession failed earlier) — recreate then retry once.
                await startSession(sessionId);
                result = await pushPcm(sessionId, params);
            } else if (err instanceof PushPcmServerError && attempt < MAX_SERVER_RETRIES) {
                // Transient server error (e.g., nginx proxy issue) — retry with backoff.
                continue;
            } else {
                throw err;
            }
        }
        return { status: result.status };
    }
    // Unreachable: the final iteration always throws or returns.
    throw new PushPcmServerError(500);
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
