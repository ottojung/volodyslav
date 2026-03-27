/**
 * Main hook for the AudioDiary recording feature.
 *
 * @module useAudioRecorder
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { makeRecorder, isRecorder } from "./recorder_logic.js";
import {
    initialRecorderState,
    initialAudioBlob,
    initialAnalyser,
    generateSessionId,
} from "./audio_helpers.js";
import { saveSessionId, clearSessionId } from "./recording_storage.js";
import {
    startSession as startBackendSession,
    uploadChunkWithSessionRetry as uploadBackendChunk,
    stopSession as stopBackendSession,
    fetchFinalAudio,
    discardSession,
} from "./session_api.js";
import { useAudioRecorderPersistence } from "./useAudioRecorder_persistence.js";
import { useAudioRecorderStateRefs } from "./useAudioRecorder_state_refs.js";
import { useAudioChunkCollector } from "./useAudioChunkCollector.js";
import { useRecordingTimer } from "./useRecordingTimer.js";

/** @typedef {import('./audio_helpers.js').RecorderState} RecorderState */

/**
 * @typedef {object} UseAudioRecorderResult
 * @property {RecorderState} recorderState
 * @property {Blob | null} audioBlob
 * @property {string} audioUrl
 * @property {string} note
 * @property {number} elapsedSeconds
 * @property {string} errorMessage
 * @property {AnalyserNode | null} analyser
 * @property {import("react").MutableRefObject<string>} mimeTypeRef
 * @property {import("react").MutableRefObject<boolean>} isMountedRef
 * @property {import("react").MutableRefObject<string>} sessionIdRef
 * @property {boolean} hasRestoredSession
 * @property {import("react").Dispatch<import("react").SetStateAction<string>>} setNote
 * @property {import("react").Dispatch<import("react").SetStateAction<string>>} setErrorMessage
 * @property {() => Promise<void>} handleStart
 * @property {() => Promise<void>} handlePauseResume
 * @property {() => Promise<void>} handleStop
 * @property {() => void} handleDiscard
 * @property {() => void} clearPersistedSession
 */

/**
 * @typedef {object} UseAudioRecorderOptions
 * @property {((data: Blob, startMs: number, endMs: number) => void) | null} [extraOnChunk] - Optional extra fragment listener.
 */

/** @param {UseAudioRecorderOptions} [options] @returns {UseAudioRecorderResult} */
export function useAudioRecorder({ extraOnChunk = null } = {}) {
    /** @type {[RecorderState, import("react").Dispatch<import("react").SetStateAction<RecorderState>>]} */
    const [recorderState, setRecorderState] = useState(initialRecorderState());

    /** @type {[Blob | null, import("react").Dispatch<import("react").SetStateAction<Blob | null>>]} */
    const [audioBlob, setAudioBlob] = useState(initialAudioBlob());

    const [audioUrl, setAudioUrl] = useState("");
    const [note, setNote] = useState("");
    const [elapsedSeconds, setElapsedSeconds] = useState(0);
    const [errorMessage, setErrorMessage] = useState("");
    /** @type {[AnalyserNode | null, import("react").Dispatch<import("react").SetStateAction<AnalyserNode | null>>]} */
    const [analyser, setAnalyser] = useState(initialAnalyser());
    const [hasRestoredSession, setHasRestoredSession] = useState(false);

    /** @type {import("react").MutableRefObject<ReturnType<typeof makeRecorder> | null>} */
    const recorderRef = useRef(null);
    /** @type {import("react").MutableRefObject<number | null>} */
    const timerRef = useRef(null);
    const mimeTypeRef = useRef("");
    const isMountedRef = useRef(false);
    /** @type {import("react").MutableRefObject<number>} */
    const restoredOffsetMsRef = useRef(0);
    /** @type {import("react").MutableRefObject<string>} */
    const sessionIdRef = useRef("");
    /** @type {import("react").MutableRefObject<number>} */
    const sequenceRef = useRef(-1);
    /** @type {import("react").MutableRefObject<Promise<void>>} */
    const uploadQueueRef = useRef(Promise.resolve());

    const { pushChunk, resetAudioChunks } =
        useAudioChunkCollector();

    const {
        audioBlobRef,
        isRestoredPauseRef,
        recorderStateRef,
        elapsedSecondsRef,
    } = useAudioRecorderStateRefs(recorderState, elapsedSeconds);

    useAudioRecorderPersistence({
        recorderStateRef,
        elapsedSecondsRef,
        mimeTypeRef,
        isMountedRef,
        sessionIdRef,
        isRestoredPauseRef,
        audioBlobRef,
        sequenceRef,
        setRecorderState,
        setElapsedSeconds,
        setHasRestoredSession,
        setAudioBlob,
        setAudioUrl,
    });

    useEffect(() => {
        isMountedRef.current = true;

        const recorder = makeRecorder({
            onStateChange: (state) => {
                if (!isMountedRef.current) return;
                recorderStateRef.current = state;
                setRecorderState(state);
            },
            onStop: (blob) => {
                if (!isMountedRef.current) return;
                mimeTypeRef.current = blob.type;
                // Set local blob first as a fallback
                audioBlobRef.current = blob;
                setAudioBlob(blob);
                setAudioUrl(URL.createObjectURL(blob));

                // Async: drain upload queue, then finalize + fetch from backend
                const sessionId = sessionIdRef.current;
                if (sessionId) {
                    void (async () => {
                        try {
                            await uploadQueueRef.current;
                            await stopBackendSession(sessionId, elapsedSecondsRef.current);
                            const backendBlob = await fetchFinalAudio(sessionId);
                            if (!isMountedRef.current) return;
                            mimeTypeRef.current = backendBlob.type;
                            audioBlobRef.current = backendBlob;
                            setAudioBlob(backendBlob);
                            setAudioUrl(URL.createObjectURL(backendBlob));
                        } catch {
                            // Keep the local fallback blob
                        }
                    })();
                }
            },
            onError: (message) => {
                if (!isMountedRef.current) return;
                setErrorMessage(message);
            },
            onAnalyser: (node) => {
                if (!isMountedRef.current) return;
                setAnalyser(node);
            },
            onChunk: (chunk, startMs, endMs) => {
                if (!isMountedRef.current) return;
                if (chunk.type) {
                    mimeTypeRef.current = chunk.type;
                }
                const offsetMs = restoredOffsetMsRef.current;
                pushChunk(chunk, startMs + offsetMs, endMs + offsetMs);

                // Notify the extra fragment listener if provided (e.g., live questioning controller).
                extraOnChunk?.(chunk, startMs + offsetMs, endMs + offsetMs);

                // Enqueue chunk upload to backend (serialized)
                const seq = sequenceRef.current + 1;
                sequenceRef.current = seq;
                const sessionId = sessionIdRef.current;
                const mimeType = chunk.type || mimeTypeRef.current;
                if (sessionId) {
                    uploadQueueRef.current = uploadQueueRef.current.then(async () => {
                        if (sessionId !== sessionIdRef.current) return;
                        try {
                            await uploadBackendChunk(sessionId, mimeType || "audio/webm", {
                                chunk,
                                startMs: startMs + offsetMs,
                                endMs: endMs + offsetMs,
                                sequence: seq,
                                mimeType,
                            });
                        } catch {
                            // Chunk upload failed; recording continues locally
                        }
                    });
                }
            },
        });

        recorderRef.current = recorder;

        // Flush pending recorder data when page goes into background/is about to unload
        function handleVisibilityChange() {
            if (document.visibilityState !== "hidden") {
                return;
            }
            if (isRecorder(recorderRef.current) && recorderStateRef.current === "recording") {
                recorderRef.current.requestData();
            }
        }

        function handlePageHide() {
            if (isRecorder(recorderRef.current) && recorderStateRef.current === "recording") {
                recorderRef.current.requestData();
            }
        }

        document.addEventListener("visibilitychange", handleVisibilityChange);
        window.addEventListener("pagehide", handlePageHide);

        return () => {
            isMountedRef.current = false;
            document.removeEventListener("visibilitychange", handleVisibilityChange);
            window.removeEventListener("pagehide", handlePageHide);
            if (isRecorder(recorderRef.current)) {
                recorderRef.current.discard();
            }
            recorderRef.current = null;
        };
    }, []); // runs once – recorder instance is stable

    useEffect(() => {
        return () => {
            if (audioUrl) {
                URL.revokeObjectURL(audioUrl);
            }
        };
    }, [audioUrl]);

    useRecordingTimer(recorderState, timerRef, setElapsedSeconds);

    const handleStart = useCallback(async () => {
        clearSessionId();
        setHasRestoredSession(false);
        setErrorMessage("");
        setElapsedSeconds(0);
        audioBlobRef.current = null;
        setAudioBlob(null);
        isRestoredPauseRef.current = false;
        restoredOffsetMsRef.current = 0;
        sequenceRef.current = -1;
        uploadQueueRef.current = Promise.resolve();
        resetAudioChunks();
        if (audioUrl) {
            setAudioUrl("");
        }

        // Generate and store session ID before starting recorder
        const newSessionId = generateSessionId();
        sessionIdRef.current = newSessionId;
        saveSessionId(newSessionId);

        if (isRecorder(recorderRef.current)) {
            await recorderRef.current.start();
        }

        // Start backend session (best-effort; recording continues even if this fails)
        try {
            await startBackendSession(newSessionId, mimeTypeRef.current || "audio/webm");
        } catch {
            // Non-fatal
        }
    }, [audioUrl, resetAudioChunks]);

    const handlePauseResume = useCallback(async () => {
        if (!isRecorder(recorderRef.current)) {
            return;
        }
        if (recorderState === "recording") {
            recorderRef.current.pause();
        } else if (recorderState === "paused") {
            if (isRestoredPauseRef.current) {
                restoredOffsetMsRef.current = elapsedSecondsRef.current * 1000;
                isRestoredPauseRef.current = false;
                await recorderRef.current.start();
            } else {
                recorderRef.current.resume();
            }
        }
    }, [recorderState]);

    const handleStop = useCallback(async () => {
        if (isRestoredPauseRef.current) {
            // Session was in restored-paused state; finalize on backend
            isRestoredPauseRef.current = false;
            recorderStateRef.current = "stopped";
            setRecorderState("stopped");
            const sessionId = sessionIdRef.current;
            if (sessionId) {
                try {
                    await stopBackendSession(sessionId, elapsedSecondsRef.current);
                    const blob = await fetchFinalAudio(sessionId);
                    if (isMountedRef.current) {
                        mimeTypeRef.current = blob.type;
                        audioBlobRef.current = blob;
                        setAudioBlob(blob);
                        setAudioUrl(URL.createObjectURL(blob));
                        recorderStateRef.current = "stopped";
                        setRecorderState("stopped");
                    }
                } catch {
                    // Backend finalize failed; keep local fallback if any
                }
            }
            return;
        }
        if (isRecorder(recorderRef.current)) {
            recorderRef.current.stop();
            // Backend finalization happens in the onStop callback after upload queue drains
        }
    }, [
        audioBlobRef,
        elapsedSecondsRef,
        isMountedRef,
        isRestoredPauseRef,
        mimeTypeRef,
        recorderStateRef,
        setAudioBlob,
        setAudioUrl,
        setRecorderState,
    ]);

    const handleDiscard = useCallback(() => {
        isRestoredPauseRef.current = false;
        audioBlobRef.current = null;
        restoredOffsetMsRef.current = 0;
        sequenceRef.current = -1;
        resetAudioChunks();
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

        const sessionId = sessionIdRef.current;
        clearSessionId();
        sessionIdRef.current = "";
        if (sessionId) {
            void discardSession(sessionId);
        }
    }, [audioUrl, resetAudioChunks]);

    const clearPersistedSession = useCallback(() => {
        setHasRestoredSession(false);
        const sessionId = sessionIdRef.current;
        clearSessionId();
        sessionIdRef.current = "";
        if (sessionId) {
            void discardSession(sessionId);
        }
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
        sessionIdRef,
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
