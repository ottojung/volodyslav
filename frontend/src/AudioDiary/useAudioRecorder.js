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
import { clearRecordingSnapshot } from "./recording_storage.js";
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
 * @property {() => void} handleStop
 * @property {() => void} handleDiscard
 * @property {() => void} clearPersistedSession
 */

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
                audioBlobRef.current = finalBlob;
                setAudioBlob(finalBlob);
                setAudioUrl(URL.createObjectURL(finalBlob));
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
                // When resuming a restored paused session the underlying MediaRecorder
                // restarts its timestamps at 0. Apply the stable offset captured at
                // resume time so all fragments stay on a continuous timeline.
                const offsetMs = restoredOffsetMsRef.current;
                chunksRef.current.push(chunk);
                pushChunk(chunk, startMs + offsetMs, endMs + offsetMs);
                // Call queuePersistSnapshot() on every 10 s fragment. This is
                // fine performance-wise because queuePersistSnapshot() is
                // debounced (250 ms) and IndexedDB writes are async (off the
                // main thread), so the UI is never blocked. The Blob
                // combination that precedes the write is the only real cost,
                // and it is proportional to recording length, but runs at most
                // once per 10 s — well within acceptable limits for a typical
                // diary recording session.
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
        return () => { if (audioUrl) { URL.revokeObjectURL(audioUrl); } };
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
        await clearRecordingSnapshot();
        setHasRestoredSession(false);
        setErrorMessage("");
        setElapsedSeconds(0);
        audioBlobRef.current = null;
        setAudioBlob(null);
        chunksRef.current = [];
        restoredAudioRef.current = null;
        isRestoredPauseRef.current = false;
        restoredOffsetMsRef.current = 0;
        resetAudioChunks();
        if (audioUrl) {
            setAudioUrl("");
        }
        if (isRecorder(recorderRef.current)) {
            await recorderRef.current.start();
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
                // Restored session: resume by starting a fresh MediaRecorder.
                // New chunks will be combined with the restored audio in onStop.
                // Capture the stable offset here so all fragments use the same base.
                restoredOffsetMsRef.current = elapsedSecondsRef.current * 1000;
                isRestoredPauseRef.current = false;
                await recorderRef.current.start();
            } else {
                recorderRef.current.resume();
            }
        }
    }, [recorderState]);

    const handleStop = useCallback(() => {
        if (stopRestoredPausedSession({
            isRestoredPauseRef, restoredAudioRef, mimeTypeRef, audioBlobRef,
            recorderStateRef, setAudioBlob, setAudioUrl, setRecorderState, persistSnapshot,
        })) { return; }
        if (isRecorder(recorderRef.current)) { recorderRef.current.stop(); }
    }, [audioBlobRef, isRestoredPauseRef, mimeTypeRef, persistSnapshot, recorderStateRef, restoredAudioRef]);

    const handleDiscard = useCallback(() => {
        isRestoredPauseRef.current = false;
        restoredAudioRef.current = null;
        audioBlobRef.current = null;
        chunksRef.current = [];
        restoredOffsetMsRef.current = 0;
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
        void clearRecordingSnapshot();
    }, [audioUrl, resetAudioChunks]);

    const clearPersistedSession = useCallback(() => {
        setHasRestoredSession(false);
        void clearRecordingSnapshot();
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
