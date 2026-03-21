/**
 * Custom React hook for managing audio recorder state and lifecycle.
 *
 * Handles the MediaRecorder state machine, live timer, audio analyser, and
 * recorder controls (start, pause/resume, stop, discard).
 *
 * Recording state is automatically persisted to IndexedDB on every pause and
 * on page-visibility changes so that interrupted sessions can be restored.
 *
 * @module useAudioRecorder
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { makeRecorder, isRecorder } from "./recorder_logic.js";
import {
    initialRecorderState,
    initialAudioBlob,
    initialAnalyser,
} from "./audio_helpers.js";
import {
    saveRecordingSnapshot,
    loadRecordingSnapshot,
    clearRecordingSnapshot,
    blobToArrayBuffer,
} from "./recording_storage.js";
import { combineChunks } from "./recorder_helpers.js";

/** @typedef {import('./audio_helpers.js').RecorderState} RecorderState */
/** @typedef {import('./recording_storage.js').RecordingSnapshot} RecordingSnapshot */

/**
 * @typedef {object} UseAudioRecorderResult
 * @property {RecorderState} recorderState - current recorder state
 * @property {Blob | null} audioBlob - final recorded blob (after stop)
 * @property {string} audioUrl - object URL for the recorded blob
 * @property {string} note - user-entered note text
 * @property {number} elapsedSeconds - elapsed recording seconds
 * @property {string} errorMessage - latest error message
 * @property {AnalyserNode | null} analyser - live audio analyser node
 * @property {import("react").MutableRefObject<string>} mimeTypeRef - current MIME type ref
 * @property {import("react").MutableRefObject<boolean>} isMountedRef - mount status ref
 * @property {boolean} hasRestoredSession - true when state was loaded from storage
 * @property {import("react").Dispatch<import("react").SetStateAction<string>>} setNote
 * @property {import("react").Dispatch<import("react").SetStateAction<string>>} setErrorMessage
 * @property {() => Promise<void>} handleStart
 * @property {() => Promise<void>} handlePauseResume
 * @property {() => void} handleStop
 * @property {() => void} handleDiscard
 * @property {() => void} clearPersistedSession
 */

/**
 * Custom hook for managing audio recorder lifecycle and controls.
 * @returns {UseAudioRecorderResult}
 */
export function useAudioRecorder() {
    /** @type {[RecorderState, import("react").Dispatch<import("react").SetStateAction<RecorderState>>]} */
    const [recorderState, setRecorderState] = useState(initialRecorderState());

    /** @type {[Blob | null, import("react").Dispatch<import("react").SetStateAction<Blob | null>>]} */
    const [audioBlob, setAudioBlob] = useState(initialAudioBlob());

    /** @type {[string, import("react").Dispatch<import("react").SetStateAction<string>>]} */
    const [audioUrl, setAudioUrl] = useState("");

    /** @type {[string, import("react").Dispatch<import("react").SetStateAction<string>>]} */
    const [note, setNote] = useState("");

    /** @type {[number, import("react").Dispatch<import("react").SetStateAction<number>>]} */
    const [elapsedSeconds, setElapsedSeconds] = useState(0);

    /** @type {[string, import("react").Dispatch<import("react").SetStateAction<string>>]} */
    const [errorMessage, setErrorMessage] = useState("");

    /** @type {[AnalyserNode | null, import("react").Dispatch<import("react").SetStateAction<AnalyserNode | null>>]} */
    const [analyser, setAnalyser] = useState(initialAnalyser());

    /** @type {[boolean, import("react").Dispatch<import("react").SetStateAction<boolean>>]} */
    const [hasRestoredSession, setHasRestoredSession] = useState(false);

    /** @type {import("react").MutableRefObject<ReturnType<typeof makeRecorder> | null>} */
    const recorderRef = useRef(null);

    /** @type {import("react").MutableRefObject<number | null>} */
    const timerRef = useRef(null);

    /** @type {import("react").MutableRefObject<string>} */
    const mimeTypeRef = useRef("");

    /** @type {import("react").MutableRefObject<boolean>} */
    const isMountedRef = useRef(false);

    // Persistence refs
    /** @type {import("react").MutableRefObject<Blob[]>} */
    const chunksRef = useRef([]);

    /** @type {import("react").MutableRefObject<Blob | null>} */
    const restoredAudioRef = useRef(null);

    /** @type {import("react").MutableRefObject<boolean>} */
    const isRestoredPauseRef = useRef(false);

    /** @type {import("react").MutableRefObject<ArrayBuffer>} */
    const persistentBufferRef = useRef(new ArrayBuffer(0));

    // Mirror refs for reading latest values inside stable event-listener closures
    /** @type {import("react").MutableRefObject<RecorderState>} */
    const recorderStateRef = useRef(recorderState);
    recorderStateRef.current = recorderState;

    /** @type {import("react").MutableRefObject<number>} */
    const elapsedSecondsRef = useRef(elapsedSeconds);
    elapsedSecondsRef.current = elapsedSeconds;

    /** @type {import("react").MutableRefObject<string>} */
    const noteRef = useRef(note);
    noteRef.current = note;

    /** @returns {RecordingSnapshot | null} */
    const buildSnapshot = useCallback(() => {
        const state = recorderStateRef.current;
        if (state === "idle") return null;
        return {
            recorderState: state,
            elapsedSeconds: elapsedSecondsRef.current,
            note: noteRef.current,
            mimeType: mimeTypeRef.current,
            audioBuffer: persistentBufferRef.current,
        };
    }, []);

    const persistSnapshot = useCallback(() => {
        const snapshot = buildSnapshot();
        if (snapshot) {
            void saveRecordingSnapshot(snapshot);
        }
    }, [buildSnapshot]);

    // Build recorder on mount, discard on unmount
    useEffect(() => {
        isMountedRef.current = true;

        const recorder = makeRecorder({
            onStateChange: (state) => {
                if (!isMountedRef.current) return;
                setRecorderState(state);
            },
            onStop: (blob) => {
                if (!isMountedRef.current) return;
                let finalBlob = blob;
                if (restoredAudioRef.current) {
                    finalBlob = combineChunks(
                        [restoredAudioRef.current, blob],
                        blob.type || mimeTypeRef.current
                    );
                    restoredAudioRef.current = null;
                }
                mimeTypeRef.current = finalBlob.type;
                setAudioBlob(finalBlob);
                setAudioUrl(URL.createObjectURL(finalBlob));
                // Persist the final blob so it survives until submission
                void blobToArrayBuffer(finalBlob).then((buf) => {
                    persistentBufferRef.current = buf;
                    persistSnapshot();
                });
            },
            onError: (message) => {
                if (!isMountedRef.current) return;
                setErrorMessage(message);
            },
            onAnalyser: (node) => {
                if (!isMountedRef.current) return;
                setAnalyser(node);
            },
            onChunk: (chunk) => {
                if (!isMountedRef.current) return;
                chunksRef.current.push(chunk);
                const parts = restoredAudioRef.current
                    ? [restoredAudioRef.current, ...chunksRef.current]
                    : [...chunksRef.current];
                const combined = combineChunks(parts, mimeTypeRef.current);
                void blobToArrayBuffer(combined).then((buf) => {
                    persistentBufferRef.current = buf;
                    persistSnapshot();
                });
            },
        });

        recorderRef.current = recorder;

        return () => {
            isMountedRef.current = false;
            if (isRecorder(recorderRef.current)) {
                recorderRef.current.discard();
            }
            recorderRef.current = null;
        };
    }, []);

    // Revoke object URL on unmount / when blob changes
    useEffect(() => {
        return () => {
            if (audioUrl) {
                URL.revokeObjectURL(audioUrl);
            }
        };
    }, [audioUrl]);

    // Live timer while recording
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

    // Restore from persisted snapshot on mount
    useEffect(() => {
        async function tryRestore() {
            try {
                const snapshot = await loadRecordingSnapshot();
                if (!snapshot || !isMountedRef.current) return;
                const blob = new Blob([snapshot.audioBuffer], {
                    type: snapshot.mimeType,
                });
                mimeTypeRef.current = snapshot.mimeType;
                persistentBufferRef.current = snapshot.audioBuffer;
                if (snapshot.recorderState === "stopped") {
                    setAudioBlob(blob);
                    setAudioUrl(URL.createObjectURL(blob));
                    setRecorderState("stopped");
                } else {
                    restoredAudioRef.current = blob;
                    isRestoredPauseRef.current = true;
                    setRecorderState("paused");
                }
                setElapsedSeconds(snapshot.elapsedSeconds);
                setNote(snapshot.note);
                setHasRestoredSession(true);
            } catch {
                // If loading fails, start fresh silently
            }
        }
        void tryRestore();
    }, []);

    // Save when state transitions to paused (ensures pauses are always captured)
    useEffect(() => {
        if (recorderState === "paused") {
            persistSnapshot();
        }
    }, [recorderState, persistSnapshot]);

    // Save on page-visibility change and before unload for interrupt resilience
    useEffect(() => {
        const onHidden = () => {
            if (document.visibilityState === "hidden") {
                persistSnapshot();
                // Also request latest buffered data; the onChunk handler will
                // update persistentBufferRef and save again when it arrives.
                if (isRecorder(recorderRef.current)) {
                    recorderRef.current.requestData();
                }
            }
        };
        const onBeforeUnload = () => {
            persistSnapshot();
        };
        document.addEventListener("visibilitychange", onHidden);
        window.addEventListener("beforeunload", onBeforeUnload);
        return () => {
            document.removeEventListener("visibilitychange", onHidden);
            window.removeEventListener("beforeunload", onBeforeUnload);
        };
    }, [persistSnapshot]);

    const handleStart = useCallback(async () => {
        setErrorMessage("");
        setElapsedSeconds(0);
        setAudioBlob(null);
        chunksRef.current = [];
        restoredAudioRef.current = null;
        isRestoredPauseRef.current = false;
        persistentBufferRef.current = new ArrayBuffer(0);
        if (audioUrl) {
            setAudioUrl("");
        }
        if (isRecorder(recorderRef.current)) {
            await recorderRef.current.start();
        }
    }, [audioUrl]);

    const handlePauseResume = useCallback(async () => {
        if (!isRecorder(recorderRef.current)) {
            return;
        }
        if (recorderState === "recording") {
            recorderRef.current.pause();
        } else if (recorderState === "paused") {
            if (isRestoredPauseRef.current) {
                // Restored session: resume by starting a fresh MediaRecorder.
                // New chunks will be combined with the restored audio in onStop.
                isRestoredPauseRef.current = false;
                await recorderRef.current.start();
            } else {
                recorderRef.current.resume();
            }
        }
    }, [recorderState]);

    const handleStop = useCallback(() => {
        if (isRestoredPauseRef.current) {
            // User stopped without resuming – deliver the restored audio directly.
            isRestoredPauseRef.current = false;
            const blob = restoredAudioRef.current;
            if (blob) {
                restoredAudioRef.current = null;
                mimeTypeRef.current = blob.type;
                setAudioBlob(blob);
                setAudioUrl(URL.createObjectURL(blob));
                setRecorderState("stopped");
                void blobToArrayBuffer(blob).then((buf) => {
                    persistentBufferRef.current = buf;
                    persistSnapshot();
                });
            }
            return;
        }
        if (isRecorder(recorderRef.current)) {
            recorderRef.current.stop();
        }
    }, [persistSnapshot]);

    const handleDiscard = useCallback(() => {
        isRestoredPauseRef.current = false;
        restoredAudioRef.current = null;
        chunksRef.current = [];
        persistentBufferRef.current = new ArrayBuffer(0);
        if (isRecorder(recorderRef.current)) {
            recorderRef.current.discard();
        }
        setAudioBlob(null);
        if (audioUrl) {
            setAudioUrl("");
        }
        setElapsedSeconds(0);
        setNote("");
        setErrorMessage("");
        setAnalyser(null);
        setHasRestoredSession(false);
        void clearRecordingSnapshot();
    }, [audioUrl]);

    const clearPersistedSession = useCallback(() => {
        setHasRestoredSession(false);
        void clearRecordingSnapshot();
    }, []);

    return {
        recorderState,
        audioBlob,
        audioUrl,
        note,
        elapsedSeconds,
        errorMessage,
        analyser,
        mimeTypeRef,
        isMountedRef,
        hasRestoredSession,
        setNote,
        setErrorMessage,
        handleStart,
        handlePauseResume,
        handleStop,
        handleDiscard,
        clearPersistedSession,
    };
}
