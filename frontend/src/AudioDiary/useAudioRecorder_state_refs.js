import { useRef } from "react";

/**
 * @typedef {import('./audio_helpers.js').RecorderState} RecorderState
 */

/**
 * Persistent refs used by useAudioRecorder to coordinate recorder state and
 * persistence logic without stale closure issues.
 *
 * @param {RecorderState} recorderState
 * @param {number} elapsedSeconds
 * @param {string} note
 * @returns {{
 *   chunksRef: import("react").MutableRefObject<Blob[]>,
 *   restoredAudioRef: import("react").MutableRefObject<Blob | null>,
 *   audioBlobRef: import("react").MutableRefObject<Blob | null>,
 *   isRestoredPauseRef: import("react").MutableRefObject<boolean>,
 *   recorderStateRef: import("react").MutableRefObject<RecorderState>,
 *   elapsedSecondsRef: import("react").MutableRefObject<number>,
 *   noteRef: import("react").MutableRefObject<string>
 * }}
 */
export function useAudioRecorderStateRefs(recorderState, elapsedSeconds, note) {
    /** @type {import("react").MutableRefObject<Blob[]>} */
    const chunksRef = useRef([]);
    /** @type {import("react").MutableRefObject<Blob | null>} */
    const restoredAudioRef = useRef(null);
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
    /** @type {import("react").MutableRefObject<string>} */
    const noteRef = useRef(note);
    noteRef.current = note;
    return {
        chunksRef,
        restoredAudioRef,
        audioBlobRef,
        isRestoredPauseRef,
        recorderStateRef,
        elapsedSecondsRef,
        noteRef,
    };
}
