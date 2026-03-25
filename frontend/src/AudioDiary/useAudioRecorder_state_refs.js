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
 * @param {string} _note - unused, kept for call-site compatibility
 * @returns {{
 *   audioBlobRef: import("react").MutableRefObject<Blob | null>,
 *   isRestoredPauseRef: import("react").MutableRefObject<boolean>,
 *   recorderStateRef: import("react").MutableRefObject<RecorderState>,
 *   elapsedSecondsRef: import("react").MutableRefObject<number>,
 * }}
 */
export function useAudioRecorderStateRefs(recorderState, elapsedSeconds, _note) {
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
    return {
        audioBlobRef,
        isRestoredPauseRef,
        recorderStateRef,
        elapsedSecondsRef,
    };
}
