import { useCallback, useEffect, useRef } from "react";
import {
    blobToArrayBuffer,
    loadRecordingSnapshot,
    saveRecordingSnapshot,
} from "./recording_storage.js";
import { combineChunks } from "./recorder_helpers.js";
import { isRecorder } from "./recorder_logic.js";

/**
 * @typedef {import('./audio_helpers.js').RecorderState} RecorderState
 */

/**
 * @typedef {object} PersistenceRefs
 * @property {import("react").MutableRefObject<RecorderState>} recorderStateRef
 * @property {import("react").MutableRefObject<number>} elapsedSecondsRef
 * @property {import("react").MutableRefObject<string>} noteRef
 * @property {import("react").MutableRefObject<string>} mimeTypeRef
 * @property {import("react").MutableRefObject<Blob[]>} chunksRef
 * @property {import("react").MutableRefObject<Blob | null>} restoredAudioRef
 * @property {import("react").MutableRefObject<Blob | null>} audioBlobRef
 * @property {import("react").MutableRefObject<boolean>} isRestoredPauseRef
 * @property {import("react").MutableRefObject<ReturnType<import('./recorder_logic.js').makeRecorder> | null>} recorderRef
 * @property {import("react").MutableRefObject<boolean>} isMountedRef
 */

/**
 * @typedef {object} PersistenceSetters
 * @property {import("react").Dispatch<import("react").SetStateAction<RecorderState>>} setRecorderState
 * @property {import("react").Dispatch<import("react").SetStateAction<Blob | null>>} setAudioBlob
 * @property {import("react").Dispatch<import("react").SetStateAction<string>>} setAudioUrl
 * @property {import("react").Dispatch<import("react").SetStateAction<number>>} setElapsedSeconds
 * @property {import("react").Dispatch<import("react").SetStateAction<string>>} setNote
 * @property {import("react").Dispatch<import("react").SetStateAction<boolean>>} setHasRestoredSession
 */

/**
 * @typedef {object} PersistOptions
 * @property {RecorderState} [stateOverride]
 * @property {Blob | null} [stoppedBlobOverride]
 */

/**
 * Persistence helper hook for useAudioRecorder.
 *
 * Handles restoring state on mount, debounced snapshot persistence, and
 * browser interrupt events (`visibilitychange`, `beforeunload`, `pagehide`).
 *
 * @param {PersistenceRefs & PersistenceSetters & { recorderState: RecorderState }} args
 * @returns {{ persistSnapshot: (options?: PersistOptions) => Promise<void>, queuePersistSnapshot: () => void }}
 */
export function useAudioRecorderPersistence(args) {
    const {
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
    } = args;

    /** @type {import("react").MutableRefObject<number | null>} */
    const persistTimerRef = useRef(null);

    const persistSnapshot = useCallback(
        /**
         * @param {PersistOptions} [options]
         * @returns {Promise<void>}
         */
        async (options = {}) => {
            const state = options.stateOverride ?? recorderStateRef.current;
            if (state === "idle") {
                return;
            }

            let audioBuffer = new ArrayBuffer(0);
            try {
                /** @type {Blob | null} */
                let blobToStore = null;
                if (state === "stopped") {
                    blobToStore = options.stoppedBlobOverride ?? audioBlobRef.current;
                } else {
                    const parts = [];
                    if (restoredAudioRef.current) {
                        parts.push(restoredAudioRef.current);
                    }
                    parts.push(...chunksRef.current);
                    if (parts.length > 0) {
                        blobToStore = combineChunks(parts, mimeTypeRef.current);
                    }
                }
                if (blobToStore) {
                    audioBuffer = await blobToArrayBuffer(blobToStore);
                }
            } catch {
                // Conversion failed; save metadata-only snapshot.
            }

            await saveRecordingSnapshot({
                recorderState: state,
                elapsedSeconds: elapsedSecondsRef.current,
                note: noteRef.current,
                mimeType: mimeTypeRef.current,
                audioBuffer,
            });
        },
        [
            audioBlobRef,
            chunksRef,
            elapsedSecondsRef,
            mimeTypeRef,
            noteRef,
            recorderStateRef,
            restoredAudioRef,
        ]
    );

    const queuePersistSnapshot = useCallback(() => {
        if (persistTimerRef.current !== null) {
            clearTimeout(persistTimerRef.current);
        }
        persistTimerRef.current = window.setTimeout(() => {
            persistTimerRef.current = null;
            void persistSnapshot();
        }, 250);
    }, [persistSnapshot]);

    useEffect(() => {
        return () => {
            if (persistTimerRef.current !== null) {
                clearTimeout(persistTimerRef.current);
                persistTimerRef.current = null;
            }
        };
    }, []);

    useEffect(() => {
        async function tryRestore() {
            const snapshot = await loadRecordingSnapshot();
            if (!snapshot || !isMountedRef.current) {
                return;
            }
            const blob = new Blob([snapshot.audioBuffer], {
                type: snapshot.mimeType,
            });
            if (!isMountedRef.current) {
                return;
            }
            mimeTypeRef.current = snapshot.mimeType;
            if (snapshot.recorderState === "stopped") {
                audioBlobRef.current = blob;
                recorderStateRef.current = "stopped";
                setAudioBlob(blob);
                setAudioUrl(URL.createObjectURL(blob));
                setRecorderState("stopped");
            } else {
                restoredAudioRef.current = blob;
                isRestoredPauseRef.current = true;
                recorderStateRef.current = "paused";
                setRecorderState("paused");
            }
            if (!isMountedRef.current) {
                return;
            }
            setElapsedSeconds(snapshot.elapsedSeconds);
            setNote(snapshot.note);
            setHasRestoredSession(true);
        }
        void tryRestore();
    }, [audioBlobRef, isMountedRef, mimeTypeRef, recorderStateRef, restoredAudioRef, setAudioBlob, setAudioUrl, setElapsedSeconds, setHasRestoredSession, setNote, setRecorderState]);

    useEffect(() => {
        if (recorderState === "paused") {
            void persistSnapshot();
        }
    }, [persistSnapshot, recorderState]);

    useEffect(() => {
        const flushAndPersist = () => {
            if (isRecorder(recorderRef.current)) {
                recorderRef.current.requestData();
            }
            void persistSnapshot();
        };
        const onHidden = () => {
            if (document.visibilityState === "hidden") {
                flushAndPersist();
            }
        };
        const onBeforeUnload = () => {
            flushAndPersist();
        };
        document.addEventListener("visibilitychange", onHidden);
        window.addEventListener("beforeunload", onBeforeUnload);
        window.addEventListener("pagehide", onBeforeUnload);
        return () => {
            document.removeEventListener("visibilitychange", onHidden);
            window.removeEventListener("beforeunload", onBeforeUnload);
            window.removeEventListener("pagehide", onBeforeUnload);
        };
    }, [persistSnapshot, recorderRef]);

    return { persistSnapshot, queuePersistSnapshot };
}
