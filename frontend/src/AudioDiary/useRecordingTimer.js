/**
 * Hook that runs a 1-second interval timer while recording is active.
 *
 * @module useRecordingTimer
 */

import { useEffect } from "react";

/**
 * @param {import('./audio_helpers.js').RecorderState} recorderState
 * @param {import("react").MutableRefObject<number | null>} timerRef
 * @param {import("react").Dispatch<import("react").SetStateAction<number>>} setElapsedSeconds
 */
export function useRecordingTimer(recorderState, timerRef, setElapsedSeconds) {
    useEffect(() => {
        if (recorderState === "recording") {
            timerRef.current = window.setInterval(() => {
                setElapsedSeconds((s) => s + 1);
            }, 1000);
        } else {
            if (timerRef.current !== null) {
                clearInterval(timerRef.current);
                timerRef.current = null;
            }
        }

        return () => {
            if (timerRef.current !== null) {
                clearInterval(timerRef.current);
                timerRef.current = null;
            }
        };
    }, [recorderState]);
}
