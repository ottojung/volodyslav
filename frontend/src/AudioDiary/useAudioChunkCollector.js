/**
 * React hook that manages an AudioChunkCollector for useAudioRecorder.
 *
 * @module useAudioChunkCollector
 */

import { useRef, useState, useCallback } from "react";
import {
    makeAudioChunkCollector,
    initialAudioChunks,
} from "./audio_chunk_collector.js";

/** @typedef {import('./audio_chunk_collector.js').AudioChunk} AudioChunk */

/**
 * @param {import("react").MutableRefObject<boolean>} isMountedRef
 * @returns {{
 *   audioChunks: AudioChunk[],
 *   pushChunk: (data: Blob, startMs: number, endMs: number) => void,
 *   resetAudioChunks: () => void
 * }}
 */
export function useAudioChunkCollector(isMountedRef) {
    /** @type {[AudioChunk[], import("react").Dispatch<import("react").SetStateAction<AudioChunk[]>>]} */
    const [audioChunks, setAudioChunks] = useState(initialAudioChunks());

    /** @type {import("react").MutableRefObject<ReturnType<typeof makeAudioChunkCollector> | null>} */
    const chunkCollectorRef = useRef(null);

    // Lazy initialization: create collector only on first render so that
    // makeAudioChunkCollector() is not called on every re-render.
    if (chunkCollectorRef.current === null) {
        chunkCollectorRef.current = makeAudioChunkCollector((chunk) => {
            if (!isMountedRef.current) return;
            setAudioChunks((prev) => [...prev, chunk]);
        });
    }

    const pushChunk = useCallback(
        /**
         * @param {Blob} data
         * @param {number} startMs
         * @param {number} endMs
         */
        (data, startMs, endMs) => {
            if (chunkCollectorRef.current !== null) {
                chunkCollectorRef.current.push(data, startMs, endMs);
            }
        },
        []
    );

    const resetAudioChunks = useCallback(() => {
        setAudioChunks(initialAudioChunks());
        if (chunkCollectorRef.current !== null) {
            chunkCollectorRef.current.reset();
        }
    }, []);

    return { audioChunks, pushChunk, resetAudioChunks };
}
