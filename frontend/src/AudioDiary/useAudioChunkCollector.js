/**
 * React hook that manages an AudioChunkCollector for useAudioRecorder.
 *
 * @module useAudioChunkCollector
 */

import { useRef, useCallback } from "react";
import { makeAudioChunkCollector } from "./audio_chunk_collector.js";

/**
 * @returns {{
 *   pushChunk: (data: Blob, startMs: number, endMs: number) => void,
 *   resetAudioChunks: () => void
 * }}
 */
export function useAudioChunkCollector() {
    /** @type {import("react").MutableRefObject<ReturnType<typeof makeAudioChunkCollector> | null>} */
    const chunkCollectorRef = useRef(null);

    // Lazy initialization: create collector only on first render so that
    // makeAudioChunkCollector() is not called on every re-render.
    if (chunkCollectorRef.current === null) {
        chunkCollectorRef.current = makeAudioChunkCollector(() => {});
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
        if (chunkCollectorRef.current !== null) {
            chunkCollectorRef.current.reset();
        }
    }, []);

    return { pushChunk, resetAudioChunks };
}
