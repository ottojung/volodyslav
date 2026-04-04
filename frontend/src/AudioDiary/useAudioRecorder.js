/**
 * Main hook for the AudioDiary recording feature.
 *
 * @module useAudioRecorder
 */

import { useState, useEffect, useRef } from "react";
import { makeRecorder, isRecorder } from "./recorder_logic.js";
import {
    initialRecorderState,
    initialAudioBlob,
    initialAnalyser,
} from "./audio_helpers.js";
import { useAudioRecorderPersistence } from "./useAudioRecorder_persistence.js";
import { useAudioRecorderStateRefs } from "./useAudioRecorder_state_refs.js";
import { useRecordingTimer } from "./useRecordingTimer.js";
import { createRecorderCallbacks } from "./useAudioRecorder_recorder_callbacks.js";
import { createAudioRecorderActionHandlers } from "./useAudioRecorder_action_handlers.js";

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
 * @typedef {import('./session_api.js').DiaryQuestion} DiaryQuestion
 */

/**
 * @typedef {object} UseAudioRecorderOptions
 * @property {((questions: DiaryQuestion[], milestoneNumber: number) => void) | null} [onQuestions] - Reserved callback for live-question delivery; current flow uses polling.
 */

/** @param {UseAudioRecorderOptions} [options] @returns {UseAudioRecorderResult} */
export function useAudioRecorder({ onQuestions = null } = {}) {
    // Reserved for future direct-delivery path; current live questions arrive via polling.
    void onQuestions;

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
    /** @type {import("react").MutableRefObject<number>} */
    const pcmUploadedCountRef = useRef(0);
    /** @type {import("react").MutableRefObject<Promise<void>>} */
    const uploadQueueRef = useRef(Promise.resolve());

    const {
        audioBlobRef,
        isRestoredPauseRef,
        recorderStateRef,
        elapsedSecondsRef,
        hasRestoredSessionRef,
    } = useAudioRecorderStateRefs(recorderState, elapsedSeconds, hasRestoredSession);

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

        const recorder = makeRecorder(
            createRecorderCallbacks({
                isMountedRef,
                recorderStateRef,
                setRecorderState,
                setAudioBlob,
                setAudioUrl,
                setAnalyser,
                setErrorMessage,
                sessionIdRef,
                pcmUploadedCountRef,
                uploadQueueRef,
                audioBlobRef,
                mimeTypeRef,
                restoredOffsetMsRef,
                sequenceRef,
                hasRestoredSessionRef,
            })
        );

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

    const {
        handleStart,
        handlePauseResume,
        handleStop,
        handleDiscard,
        clearPersistedSession,
    } = createAudioRecorderActionHandlers({
        recorderRef,
        recorderStateRef,
        isRestoredPauseRef,
        restoredOffsetMsRef,
        sequenceRef,
        pcmUploadedCountRef,
        uploadQueueRef,
        audioBlobRef,
        mimeTypeRef,
        elapsedSecondsRef,
        sessionIdRef,
        isMountedRef,
        setHasRestoredSession,
        setErrorMessage,
        setElapsedSeconds,
        setAudioBlob,
        setAudioUrl,
        setNote,
        setAnalyser,
        setRecorderState,
        audioUrl,
    });

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
