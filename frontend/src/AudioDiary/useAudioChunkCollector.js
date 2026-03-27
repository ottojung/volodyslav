/**
 * React hook that provides stable no-op chunk collector callbacks for useAudioRecorder.
 *
 * This keeps useAudioRecorder's callback wiring unchanged while avoiding
 * unnecessary fragment accumulation/combination work now that emitted chunks
 * are no longer consumed by runtime code.
 *
 * @module useAudioChunkCollector
 */

import { useCallback } from "react";

/**
 * @returns {{
 *   pushChunk: (data: Blob, startMs: number, endMs: number) => void,
 *   resetCollector: () => void
 * }}
 */
export function useAudioChunkCollector() {
    const pushChunk = useCallback(
        /**
         * @param {Blob} data
         * @param {number} startMs
         * @param {number} endMs
         */
        (_data, _startMs, _endMs) => {},
        []
    );

    const resetCollector = useCallback(() => {}, []);

    return { pushChunk, resetCollector };
}
