/**
 * @typedef {import('./audio_helpers.js').RecorderState} RecorderState
 */

import { isRecorder } from "./recorder_logic.js";
import { generateSessionId } from "./audio_helpers.js";
import {
    startSession as startBackendSession,
    stopSession as stopBackendSession,
    fetchFinalAudio,
    discardSession,
} from "./session_api.js";
import { saveSessionId, clearSessionId } from "./recording_storage.js";

/**
 * @typedef {object} CreateAudioRecorderActionHandlersParams
 * @property {import('react').MutableRefObject<any>} recorderRef
 * @property {import('react').MutableRefObject<RecorderState>} recorderStateRef
 * @property {import('react').MutableRefObject<boolean>} isRestoredPauseRef
 * @property {import('react').MutableRefObject<number>} restoredOffsetMsRef
 * @property {import('react').MutableRefObject<number>} sequenceRef
 * @property {import('react').MutableRefObject<number>} pcmUploadedCountRef
 * @property {import('react').MutableRefObject<Promise<void>>} uploadQueueRef
 * @property {import('react').MutableRefObject<Blob | null>} audioBlobRef
 * @property {import('react').MutableRefObject<string>} mimeTypeRef
 * @property {import('react').MutableRefObject<number>} elapsedSecondsRef
 * @property {import('react').MutableRefObject<string>} sessionIdRef
 * @property {import('react').MutableRefObject<boolean>} isMountedRef
 * @property {import('react').Dispatch<import('react').SetStateAction<boolean>>} setHasRestoredSession
 * @property {import('react').Dispatch<import('react').SetStateAction<string>>} setErrorMessage
 * @property {import('react').Dispatch<import('react').SetStateAction<number>>} setElapsedSeconds
 * @property {import('react').Dispatch<import('react').SetStateAction<Blob | null>>} setAudioBlob
 * @property {import('react').Dispatch<import('react').SetStateAction<string>>} setAudioUrl
 * @property {import('react').Dispatch<import('react').SetStateAction<string>>} setNote
 * @property {import('react').Dispatch<import('react').SetStateAction<AnalyserNode | null>>} setAnalyser
 * @property {import('react').Dispatch<import('react').SetStateAction<RecorderState>>} setRecorderState
 * @property {() => void} resetCollector
 * @property {string} audioUrl
 */

/**
 * @param {CreateAudioRecorderActionHandlersParams} params
 */
export function createAudioRecorderActionHandlers(params) {
    const {
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
        resetCollector,
        audioUrl,
    } = params;

    return {
        async handleStart() {
            clearSessionId();
            setHasRestoredSession(false);
            setErrorMessage("");
            setElapsedSeconds(0);
            audioBlobRef.current = null;
            setAudioBlob(null);
            isRestoredPauseRef.current = false;
            restoredOffsetMsRef.current = 0;
            sequenceRef.current = -1;
            pcmUploadedCountRef.current = 0;
            uploadQueueRef.current = Promise.resolve();
            resetCollector();
            if (audioUrl) {
                setAudioUrl("");
            }

            const newSessionId = generateSessionId();
            sessionIdRef.current = newSessionId;
            saveSessionId(newSessionId);

            if (isRecorder(recorderRef.current)) {
                await recorderRef.current.start();
            }

            try {
                await startBackendSession(newSessionId);
            } catch {
                // Non-fatal
            }
        },

        async handlePauseResume() {
            if (!isRecorder(recorderRef.current)) {
                return;
            }
            if (recorderStateRef.current === "recording") {
                recorderRef.current.pause();
            } else if (recorderStateRef.current === "paused") {
                if (isRestoredPauseRef.current) {
                    restoredOffsetMsRef.current = elapsedSecondsRef.current * 1000;
                    isRestoredPauseRef.current = false;
                    await recorderRef.current.start();
                } else {
                    recorderRef.current.resume();
                }
            }
        },

        async handleStop() {
            if (isRestoredPauseRef.current) {
                isRestoredPauseRef.current = false;
                recorderStateRef.current = "stopped";
                setRecorderState("stopped");
                const sessionId = sessionIdRef.current;
                if (sessionId) {
                    try {
                        await stopBackendSession(sessionId);
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
                        // Backend finalize failed; keep local fallback
                    }
                }
                return;
            }

            if (isRecorder(recorderRef.current)) {
                recorderRef.current.stop();
            }
        },

        handleDiscard() {
            isRestoredPauseRef.current = false;
            audioBlobRef.current = null;
            restoredOffsetMsRef.current = 0;
            sequenceRef.current = -1;
            resetCollector();
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
        },

        clearPersistedSession() {
            setHasRestoredSession(false);
            const sessionId = sessionIdRef.current;
            clearSessionId();
            sessionIdRef.current = "";
            if (sessionId) {
                void discardSession(sessionId);
            }
        },
    };
}
