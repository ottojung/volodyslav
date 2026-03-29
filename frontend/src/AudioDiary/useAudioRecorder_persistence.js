/**
 * Persistence helper hook for useAudioRecorder.
 *
 * Backend-driven: on mount, restores session from backend using the stored
 * session ID. Uses the unified restore endpoint for a single round-trip.
 *
 * @module useAudioRecorder_persistence
 */

import { useEffect } from "react";
import { loadSessionId, clearSessionId } from "./recording_storage.js";
import { getSessionRestore } from "./session_api.js";

/**
 * @typedef {import('./audio_helpers.js').RecorderState} RecorderState
 */

/**
 * @typedef {object} PersistenceRefs
 * @property {import("react").MutableRefObject<RecorderState>} recorderStateRef
 * @property {import("react").MutableRefObject<number>} elapsedSecondsRef
 * @property {import("react").MutableRefObject<string>} mimeTypeRef
 * @property {import("react").MutableRefObject<boolean>} isMountedRef
 * @property {import("react").MutableRefObject<string>} sessionIdRef
 * @property {import("react").MutableRefObject<boolean>} isRestoredPauseRef
 * @property {import("react").MutableRefObject<number>} sequenceRef
 */

/**
 * @typedef {object} PersistenceSetters
 * @property {import("react").Dispatch<import("react").SetStateAction<RecorderState>>} setRecorderState
 * @property {import("react").Dispatch<import("react").SetStateAction<number>>} setElapsedSeconds
 * @property {import("react").Dispatch<import("react").SetStateAction<boolean>>} setHasRestoredSession
 */

/**
 * Persistence hook for useAudioRecorder.
 * Restores session state from backend on mount using the stored sessionId.
 *
 * @param {PersistenceRefs & PersistenceSetters} args
 * @returns {void}
 */
export function useAudioRecorderPersistence(args) {
    const {
        recorderStateRef,
        elapsedSecondsRef,
        mimeTypeRef,
        isMountedRef,
        sessionIdRef,
        isRestoredPauseRef,
        sequenceRef,
        setRecorderState,
        setElapsedSeconds,
        setHasRestoredSession,
    } = args;

    useEffect(() => {
        async function tryRestore() {
            const sessionId = loadSessionId();
            if (!sessionId) {
                return;
            }

            let restore;
            try {
                restore = await getSessionRestore(sessionId);
            } catch {
                // Backend unavailable or error: skip restore
                return;
            }

            if (!isMountedRef.current) {
                return;
            }

            if (!restore) {
                // Session not found on backend: clear stale local id
                clearSessionId();
                return;
            }

            // Restore state from backend session
            sessionIdRef.current = sessionId;
            mimeTypeRef.current = restore.mimeType || "";
            // Seed the sequence counter so resumed uploads continue from the right position
            sequenceRef.current = restore.lastSequence;

            if (restore.status === "stopped") {
                recorderStateRef.current = "stopped";
                setRecorderState("stopped");
                // Audio blob is not restored after page reload: preview is unavailable.
                // User must re-record to get a new submission.
            } else {
                recorderStateRef.current = "paused";
                setRecorderState("paused");
                isRestoredPauseRef.current = true;
            }

            if (!isMountedRef.current) {
                return;
            }

            elapsedSecondsRef.current = restore.elapsedSeconds || 0;
            setElapsedSeconds(restore.elapsedSeconds || 0);
            setHasRestoredSession(true);
        }
        void tryRestore();
    }, [
        isMountedRef,
        sessionIdRef,
        mimeTypeRef,
        recorderStateRef,
        elapsedSecondsRef,
        isRestoredPauseRef,
        sequenceRef,
        setRecorderState,
        setElapsedSeconds,
        setHasRestoredSession,
    ]);
}
