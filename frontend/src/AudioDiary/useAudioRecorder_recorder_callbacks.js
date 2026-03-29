/**
 * @typedef {import('./audio_helpers.js').RecorderState} RecorderState
 */

import { clearSessionId } from "./recording_storage.js";
import {
    stopSession as stopBackendSession,
    fetchFinalAudio,
    discardSession,
    pushChunkWithSessionRetry as pushBackendChunk,
} from "./session_api.js";

/**
 * @typedef {object} CreateRecorderCallbacksParams
 * @property {import('react').MutableRefObject<boolean>} isMountedRef
 * @property {import('react').MutableRefObject<RecorderState>} recorderStateRef
 * @property {import('react').Dispatch<import('react').SetStateAction<RecorderState>>} setRecorderState
 * @property {import('react').Dispatch<import('react').SetStateAction<Blob | null>>} setAudioBlob
 * @property {import('react').Dispatch<import('react').SetStateAction<string>>} setAudioUrl
 * @property {import('react').Dispatch<import('react').SetStateAction<AnalyserNode | null>>} setAnalyser
 * @property {import('react').Dispatch<import('react').SetStateAction<string>>} setErrorMessage
 * @property {import('react').MutableRefObject<string>} sessionIdRef
 * @property {import('react').MutableRefObject<number>} pcmUploadedCountRef
 * @property {import('react').MutableRefObject<Promise<void>>} uploadQueueRef
 * @property {import('react').MutableRefObject<Blob | null>} audioBlobRef
 * @property {import('react').MutableRefObject<string>} mimeTypeRef
 * @property {import('react').MutableRefObject<number>} restoredOffsetMsRef
 * @property {import('react').MutableRefObject<number>} sequenceRef
 * @property {import('react').MutableRefObject<boolean>} restoredBoundaryRef
 * @property {(chunk: Blob, startMs: number, endMs: number) => void} pushChunk
 */

/**
 * @param {CreateRecorderCallbacksParams} params
 */
export function createRecorderCallbacks(params) {
    const {
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
        restoredBoundaryRef,
        pushChunk,
    } = params;

    return {
        /** @param {RecorderState} state */
        onStateChange(state) {
            if (!isMountedRef.current) return;
            recorderStateRef.current = state;
            setRecorderState(state);
        },

        /** @param {Blob} blob */
        onStop(blob) {
            if (!isMountedRef.current) return;
            mimeTypeRef.current = blob.type;
            audioBlobRef.current = blob;
            setAudioBlob(blob);
            setAudioUrl(URL.createObjectURL(blob));

            const sessionId = sessionIdRef.current;
            if (!sessionId) {
                return;
            }

            void (async () => {
                try {
                    await uploadQueueRef.current;
                    if (pcmUploadedCountRef.current === 0) {
                        try {
                            await discardSession(sessionId);
                        } catch {
                            // best effort
                        }
                        sessionIdRef.current = "";
                        clearSessionId();
                        return;
                    }

                    await stopBackendSession(sessionId);
                    const backendBlob = await fetchFinalAudio(sessionId);
                    if (!isMountedRef.current) return;
                    mimeTypeRef.current = backendBlob.type;
                    audioBlobRef.current = backendBlob;
                    setAudioBlob(backendBlob);
                    setAudioUrl(URL.createObjectURL(backendBlob));
                } catch {
                    // keep local fallback
                }
            })();
        },

        /** @param {string} message */
        onError(message) {
            if (!isMountedRef.current) return;
            setErrorMessage(message);
        },

        /** @param {AnalyserNode | null} node */
        onAnalyser(node) {
            if (!isMountedRef.current) return;
            setAnalyser(node);
        },

        /**
         * @param {Blob} chunk
         * @param {number} startMs
         * @param {number} endMs
         * @param {{ pcmBytes: ArrayBuffer; sampleRateHz: number; channels: number; bitDepth: number } | null} pcmChunk
         * @param {string} captureId
         */
        onChunk(chunk, startMs, endMs, pcmChunk, captureId) {
            if (!isMountedRef.current) return;
            const chunkMimeType = chunk.type || mimeTypeRef.current;
            if (chunk.type) {
                mimeTypeRef.current = chunk.type;
            }
            const offsetMs = restoredOffsetMsRef.current;
            pushChunk(chunk, startMs + offsetMs, endMs + offsetMs);

            if (!pcmChunk && chunk.size === 0) return;

            const seq = sequenceRef.current + 1;
            sequenceRef.current = seq;
            const sessionId = sessionIdRef.current;
            if (!sessionId) return;

            const hasRestoreBoundary = restoredBoundaryRef ? restoredBoundaryRef.current : false;

            // Build chunk params: always include media; include PCM when available
            /** @type {{ startMs: number, endMs: number, sequence: number, captureId: string, hasRestoreBoundary: boolean, mediaBlob?: Blob, mediaMimeType?: string, pcmBytes?: ArrayBuffer, sampleRateHz?: number, channels?: number, bitDepth?: number }} */
            const chunkParams = {
                startMs: startMs + offsetMs,
                endMs: endMs + offsetMs,
                sequence: seq,
                captureId,
                hasRestoreBoundary,
                mediaBlob: chunk.size > 0 ? chunk : undefined,
                mediaMimeType: chunkMimeType || undefined,
            };

            if (pcmChunk) {
                chunkParams.pcmBytes = pcmChunk.pcmBytes;
                chunkParams.sampleRateHz = pcmChunk.sampleRateHz;
                chunkParams.channels = pcmChunk.channels;
                chunkParams.bitDepth = pcmChunk.bitDepth;
            }

            uploadQueueRef.current = uploadQueueRef.current.then(async () => {
                if (sessionId !== sessionIdRef.current) return;
                try {
                    await pushBackendChunk(sessionId, chunkParams);
                    if (pcmChunk) {
                        pcmUploadedCountRef.current += 1;
                    }
                } catch {
                    // push-chunk failure: local recording continues
                }
            });
        },
    };
}
