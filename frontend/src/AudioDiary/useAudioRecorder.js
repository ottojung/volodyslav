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
} from "./audio_helpers.js";
import { saveSessionId, clearSessionId } from "./recording_storage.js";
import {
    startSession as startBackendSession,
    uploadChunk as uploadBackendChunk,
    stopSession as stopBackendSession,
    fetchFinalAudio,
    discardSession,
} from "./session_api.js";
import { combineChunks } from "./recorder_helpers.js";
import { useAudioRecorderPersistence } from "./useAudioRecorder_persistence.js";
import { useAudioRecorderStateRefs } from "./useAudioRecorder_state_refs.js";
import { stopRestoredPausedSession } from "./useAudioRecorder_stop_restore.js";
import { useAudioChunkCollector } from "./useAudioChunkCollector.js";

/** @typedef {import('./audio_helpers.js').RecorderState} RecorderState */
/** @typedef {import('./audio_chunk_collector.js').AudioChunk} AudioChunk */

/**
 * @typedef {object} UseAudioRecorderResult
 * @property {AudioChunk[]} audioChunks
 * @property {RecorderState} recorderState
 * @property {Blob | null} audioBlob
 * @property {string} audioUrl
 * @property {string} note
 * @property {number} elapsedSeconds
 * @property {string} errorMessage
 * @property {AnalyserNode | null} analyser
 * @property {import("react").MutableRefObject<string>} mimeTypeRef
 * @property {import("react").MutableRefObject<boolean>} isMountedRef
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
 * Generate a unique session ID using crypto.randomUUID() if available,
 * or a Math.random-based fallback.
 * @returns {string}
 */
function generateSessionId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    return `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** @returns {UseAudioRecorderResult} */
export function useAudioRecorder() {
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

    const { audioChunks, pushChunk, resetAudioChunks } =
        useAudioChunkCollector(isMountedRef);

    const {
        chunksRef,
        restoredAudioRef,
        audioBlobRef,
        isRestoredPauseRef,
        recorderStateRef,
        elapsedSecondsRef,
        noteRef,
    } = useAudioRecorderStateRefs(recorderState, elapsedSeconds, note);

    const { persistSnapshot, queuePersistSnapshot } = useAudioRecorderPersistence({
        recorderStateRef,
        elapsedSecondsRef,
        noteRef,
        mimeTypeRef,
        chunksRef,
        restoredAudioRef,
        audioBlobRef,
        isRestoredPauseRef,
        recorderRef,
        isMountedRef,
        sessionIdRef,
        setRecorderState,
        setAudioBlob,
        setAudioUrl,
        setElapsedSeconds,
        setNote,
        setHasRestoredSession,
        recorderState,
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
                let finalBlob = blob;
                if (restoredAudioRef.current) {
                    finalBlob = combineChunks(
                        [restoredAudioRef.current, blob],
                        blob.type || mimeTypeRef.current
                    );
                    restoredAudioRef.current = null;
                }
                mimeTypeRef.current = finalBlob.type;
                // Set local blob first as a fallback
                audioBlobRef.current = finalBlob;
                setAudioBlob(finalBlob);
                setAudioUrl(URL.createObjectURL(finalBlob));

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

                void persistSnapshot();
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
                chunksRef.current.push(chunk);
                pushChunk(chunk, startMs + offsetMs, endMs + offsetMs);

                // Enqueue chunk upload to backend (serialized)
                const seq = sequenceRef.current + 1;
                sequenceRef.current = seq;
                const sessionId = sessionIdRef.current;
                const mimeType = chunk.type || mimeTypeRef.current;
                if (sessionId) {
                    uploadQueueRef.current = uploadQueueRef.current.then(() =>
                        uploadBackendChunk(sessionId, {
                            chunk,
                            startMs: startMs + offsetMs,
                            endMs: endMs + offsetMs,
                            sequence: seq,
                            mimeType,
                        }).catch(() => {
                            // Chunk upload failed; recording continues locally
                        })
                    );
                }

                queuePersistSnapshot();
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
    }, []); // runs once – recorder instance is stable

    useEffect(() => {
        return () => {
            if (audioUrl) {
                URL.revokeObjectURL(audioUrl);
            }
        };
    }, [audioUrl]);

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

    const handleStart = useCallback(async () => {
        clearSessionId();
        setHasRestoredSession(false);
        setErrorMessage("");
        setElapsedSeconds(0);
        audioBlobRef.current = null;
        setAudioBlob(null);
        chunksRef.current = [];
        restoredAudioRef.current = null;
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
        if (
            stopRestoredPausedSession({
                isRestoredPauseRef,
                restoredAudioRef,
                mimeTypeRef,
                audioBlobRef,
                recorderStateRef,
                setAudioBlob,
                setAudioUrl,
                setRecorderState,
                persistSnapshot,
            })
        ) {
            // Session was in restored-paused state; finalize on backend
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
        persistSnapshot,
        recorderStateRef,
        restoredAudioRef,
        setAudioBlob,
        setAudioUrl,
        setRecorderState,
    ]);

    const handleDiscard = useCallback(() => {
        isRestoredPauseRef.current = false;
        restoredAudioRef.current = null;
        audioBlobRef.current = null;
        chunksRef.current = [];
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
        audioChunks,
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
