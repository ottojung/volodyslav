/**
 * Handle "stop" action when currently in restored paused mode.
 *
 * @param {{
 *   isRestoredPauseRef: import("react").MutableRefObject<boolean>,
 *   restoredAudioRef: import("react").MutableRefObject<Blob | null>,
 *   mimeTypeRef: import("react").MutableRefObject<string>,
 *   audioBlobRef: import("react").MutableRefObject<Blob | null>,
 *   recorderStateRef: import("react").MutableRefObject<import('./audio_helpers.js').RecorderState>,
 *   setAudioBlob: import("react").Dispatch<import("react").SetStateAction<Blob | null>>,
 *   setAudioUrl: import("react").Dispatch<import("react").SetStateAction<string>>,
 *   setRecorderState: import("react").Dispatch<import("react").SetStateAction<import('./audio_helpers.js').RecorderState>>,
 *   persistSnapshot: (options?: { stateOverride?: import('./audio_helpers.js').RecorderState, stoppedBlobOverride?: Blob | null }) => Promise<void>
 * }} args
 * @returns {boolean} true if handled
 */
export function stopRestoredPausedSession(args) {
    const {
        isRestoredPauseRef,
        restoredAudioRef,
        mimeTypeRef,
        audioBlobRef,
        recorderStateRef,
        setAudioBlob,
        setAudioUrl,
        setRecorderState,
        persistSnapshot,
    } = args;

    if (!isRestoredPauseRef.current) {
        return false;
    }

    isRestoredPauseRef.current = false;
    const blob = restoredAudioRef.current;
    if (!blob) {
        return true;
    }

    mimeTypeRef.current = blob.type;
    audioBlobRef.current = blob;
    setAudioBlob(blob);
    setAudioUrl(URL.createObjectURL(blob));
    recorderStateRef.current = "stopped";
    setRecorderState("stopped");
    void persistSnapshot({
        stateOverride: "stopped",
        stoppedBlobOverride: blob,
    });
    restoredAudioRef.current = null;
    return true;
}
