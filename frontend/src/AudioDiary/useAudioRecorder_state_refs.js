import { useRef } from "react";

/**
 * @typedef {import('./audio_helpers.js').RecorderState} RecorderState
 */

/**
 * Persistent refs used by useAudioRecorder to coordinate recorder state
 * without stale closure issues.
 *
 * @param {RecorderState} recorderState
 * @param {number} elapsedSeconds
 * @param {boolean} hasRestoredSession
 * @returns {{
 *   audioBlobRef: import("react").MutableRefObject<Blob | null>,
 *   isRestoredPauseRef: import("react").MutableRefObject<boolean>,
 *   recorderStateRef: import("react").MutableRefObject<RecorderState>,
 *   elapsedSecondsRef: import("react").MutableRefObject<number>,
 *   hasRestoredSessionRef: import("react").MutableRefObject<boolean>,
 * }}
 */
export function useAudioRecorderStateRefs(recorderState, elapsedSeconds, hasRestoredSession) {
    /** @type {import("react").MutableRefObject<Blob | null>} */
    const audioBlobRef = useRef(null);
    /** @type {import("react").MutableRefObject<boolean>} */
    const isRestoredPauseRef = useRef(false);
    /** @type {import("react").MutableRefObject<RecorderState>} */
    const recorderStateRef = useRef(recorderState);
    recorderStateRef.current = recorderState;
    /** @type {import("react").MutableRefObject<number>} */
    const elapsedSecondsRef = useRef(elapsedSeconds);
    elapsedSecondsRef.current = elapsedSeconds;
    /** @type {import("react").MutableRefObject<boolean>} */
    const hasRestoredSessionRef = useRef(hasRestoredSession);
    hasRestoredSessionRef.current = hasRestoredSession;
    return {
        audioBlobRef,
        isRestoredPauseRef,
        recorderStateRef,
        elapsedSecondsRef,
        hasRestoredSessionRef,
    };
}
