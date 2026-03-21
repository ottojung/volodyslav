/**
 * Custom React hook for managing audio recorder state and lifecycle.
 *
 * Handles the MediaRecorder state machine, live timer, audio analyser, and
 * recorder controls (start, pause/resume, stop, discard).
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

/** @typedef {import('./audio_helpers.js').RecorderState} RecorderState */

/**
 * @typedef {object} UseAudioRecorderResult
 * @property {RecorderState} recorderState - current recorder state
 * @property {Blob | null} audioBlob - final recorded blob (after stop)
 * @property {string} audioUrl - object URL for the recorded blob
 * @property {string} note - user-entered note text
 * @property {number} elapsedSeconds - elapsed recording seconds
 * @property {string} errorMessage - latest error message
 * @property {AnalyserNode | null} analyser - live audio analyser node
 * @property {React.MutableRefObject<string>} mimeTypeRef - current MIME type ref
 * @property {React.MutableRefObject<boolean>} isMountedRef - mount status ref
 * @property {React.Dispatch<React.SetStateAction<string>>} setNote
 * @property {React.Dispatch<React.SetStateAction<string>>} setErrorMessage
 * @property {() => Promise<void>} handleStart
 * @property {() => void} handlePauseResume
 * @property {() => void} handleStop
 * @property {() => void} handleDiscard
 */

/**
 * Custom hook for managing audio recorder lifecycle and controls.
 * @returns {UseAudioRecorderResult}
 */
export function useAudioRecorder() {
    /** @type {[RecorderState, React.Dispatch<React.SetStateAction<RecorderState>>]} */
    const [recorderState, setRecorderState] = useState(initialRecorderState());

    /** @type {[Blob | null, React.Dispatch<React.SetStateAction<Blob | null>>]} */
    const [audioBlob, setAudioBlob] = useState(initialAudioBlob());

    /** @type {[string, React.Dispatch<React.SetStateAction<string>>]} */
    const [audioUrl, setAudioUrl] = useState("");

    /** @type {[string, React.Dispatch<React.SetStateAction<string>>]} */
    const [note, setNote] = useState("");

    /** @type {[number, React.Dispatch<React.SetStateAction<number>>]} */
    const [elapsedSeconds, setElapsedSeconds] = useState(0);

    /** @type {[string, React.Dispatch<React.SetStateAction<string>>]} */
    const [errorMessage, setErrorMessage] = useState("");

    /** @type {[AnalyserNode | null, React.Dispatch<React.SetStateAction<AnalyserNode | null>>]} */
    const [analyser, setAnalyser] = useState(initialAnalyser());

    /** @type {React.MutableRefObject<ReturnType<typeof makeRecorder> | null>} */
    const recorderRef = useRef(null);

    /** @type {React.MutableRefObject<number | null>} */
    const timerRef = useRef(null);

    /** @type {React.MutableRefObject<string>} */
    const mimeTypeRef = useRef("");

    /** @type {React.MutableRefObject<boolean>} */
    const isMountedRef = useRef(false);

    // Build recorder on mount, discard on unmount
    useEffect(() => {
        isMountedRef.current = true;

        const recorder = makeRecorder({
            onStateChange: (state) => {
                if (!isMountedRef.current) {
                    return;
                }
                setRecorderState(state);
            },
            onStop: (blob) => {
                if (!isMountedRef.current) {
                    return;
                }
                mimeTypeRef.current = blob.type;
                setAudioBlob(blob);
                const url = URL.createObjectURL(blob);
                setAudioUrl(url);
            },
            onError: (message) => {
                if (!isMountedRef.current) {
                    return;
                }
                setErrorMessage(message);
            },
            onAnalyser: (node) => {
                if (!isMountedRef.current) {
                    return;
                }
                setAnalyser(node);
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

    const handleStart = useCallback(async () => {
        setErrorMessage("");
        setElapsedSeconds(0);
        setAudioBlob(null);
        if (audioUrl) {
            URL.revokeObjectURL(audioUrl);
            setAudioUrl("");
        }
        if (isRecorder(recorderRef.current)) {
            await recorderRef.current.start();
        }
    }, [audioUrl]);

    const handlePauseResume = useCallback(() => {
        if (!isRecorder(recorderRef.current)) {
            return;
        }
        if (recorderState === "recording") {
            recorderRef.current.pause();
        } else if (recorderState === "paused") {
            recorderRef.current.resume();
        }
    }, [recorderState]);

    const handleStop = useCallback(() => {
        if (isRecorder(recorderRef.current)) {
            recorderRef.current.stop();
        }
    }, []);

    const handleDiscard = useCallback(() => {
        if (isRecorder(recorderRef.current)) {
            recorderRef.current.discard();
        }
        setAudioBlob(null);
        if (audioUrl) {
            URL.revokeObjectURL(audioUrl);
            setAudioUrl("");
        }
        setElapsedSeconds(0);
        setNote("");
        setErrorMessage("");
        setAnalyser(null);
    }, [audioUrl]);

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
        setNote,
        setErrorMessage,
        handleStart,
        handlePauseResume,
        handleStop,
        handleDiscard,
    };
}
