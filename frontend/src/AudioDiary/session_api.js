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
    const data = await response.json();
    if (!data.success) {
        throw new Error(data.error || "Failed to start session");
    }
    return data.session;
}

/**
 * Upload a single audio fragment to the session.
 * @param {string} sessionId
 * @param {{ chunk: Blob, startMs: number, endMs: number, sequence: number, mimeType: string }} params
 * @returns {Promise<{ stored: { sequence: number, filename: string }, session: { fragmentCount: number, lastEndMs: number } }>}
 */
export async function uploadChunk(sessionId, { chunk, startMs, endMs, sequence, mimeType }) {
    const formData = new FormData();
    formData.append("chunk", chunk, "chunk.webm");
    formData.append("startMs", String(startMs));
    formData.append("endMs", String(endMs));
    formData.append("sequence", String(sequence));
    formData.append("mimeType", mimeType);

    const response = await fetch(`${SESSION_BASE}/${encodeURIComponent(sessionId)}/chunks`, {
        method: "POST",
        body: formData,
    });
    const data = await response.json();
    if (!data.success) {
        throw new Error(data.error || "Failed to upload chunk");
    }
    return { stored: data.stored, session: data.session };
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
    const data = await response.json();
    if (!data.success) {
        throw new Error(data.error || "Failed to get session");
    }
    return data.session;
}

/**
 * Finalize a recording session (concatenates all chunks).
 * @param {string} sessionId
 * @param {number} elapsedSeconds
 * @returns {Promise<{ status: string, size: number }>}
 */
export async function stopSession(sessionId, elapsedSeconds) {
    const response = await fetch(`${SESSION_BASE}/${encodeURIComponent(sessionId)}/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ elapsedSeconds }),
    });
    const data = await response.json();
    if (!data.success) {
        throw new Error(data.error || "Failed to stop session");
    }
    return data.session;
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
