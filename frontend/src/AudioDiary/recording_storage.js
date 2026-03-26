/**
 * Persistent storage for audio diary recording sessions.
 *
 * Stores only the active session ID in localStorage so the recording can be
 * resumed after a page reload or interruption. Audio bytes are stored on the
 * backend.
 *
 * @module recording_storage
 */

const SESSION_ID_KEY = "audioDiarySessionId";

/**
 * @deprecated No longer throws storage errors. Always returns false.
 * @param {unknown} _object
 * @returns {boolean}
 */
export function isRecordingStorageError(_object) {
    return false;
}

/**
 * Save the current session ID to localStorage.
 * @param {string} sessionId
 * @returns {void}
 */
export function saveSessionId(sessionId) {
    try {
        localStorage.setItem(SESSION_ID_KEY, sessionId);
    } catch {
        // Silently ignore storage failures
    }
}

/**
 * Load the stored session ID from localStorage.
 * Returns null if no session ID is stored.
 * @returns {string | null}
 */
export function loadSessionId() {
    try {
        return localStorage.getItem(SESSION_ID_KEY);
    } catch {
        return null;
    }
}

/**
 * Clear the stored session ID from localStorage.
 * @returns {void}
 */
export function clearSessionId() {
    try {
        localStorage.removeItem(SESSION_ID_KEY);
    } catch {
        // Silently ignore storage failures
    }
}

/**
 * @deprecated Use saveSessionId/loadSessionId/clearSessionId instead.
 * Kept for backwards compatibility with old tests only.
 * @returns {Promise<void>}
 */
export async function clearRecordingSnapshot() {
    clearSessionId();
}
