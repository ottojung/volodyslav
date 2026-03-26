/**
 * Handle "stop" action when currently in restored paused mode.
 *
 * @param {{
 *   isRestoredPauseRef: import("react").MutableRefObject<boolean>,
 *   recorderStateRef: import("react").MutableRefObject<import('./audio_helpers.js').RecorderState>,
 *   setRecorderState: import("react").Dispatch<import("react").SetStateAction<import('./audio_helpers.js').RecorderState>>,
 * }} args
 * @returns {boolean} true if handled
 */
export function stopRestoredPausedSession(args) {
    const {
        isRestoredPauseRef,
        recorderStateRef,
        setRecorderState,
    } = args;

    if (!isRestoredPauseRef.current) {
        return false;
    }

    isRestoredPauseRef.current = false;
    recorderStateRef.current = "stopped";
    setRecorderState("stopped");
    return true;
}
