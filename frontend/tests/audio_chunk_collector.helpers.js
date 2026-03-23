/**
 * Shared helpers for audio_chunk_collector tests.
 */

export {
    makeAudioChunkCollector,
    isAudioChunkCollector,
    CHUNK_DURATION_MS,
    OVERLAP_MS,
} from "../src/AudioDiary/audio_chunk_collector.js";

export const FRAGMENT_MS = 10 * 1000; // 10-second fragments (same as recorder_logic)

/**
 * @param {string} content
 * @param {string} [type]
 * @returns {Blob}
 */
export function makeBlob(content, type = "audio/webm") {
    return new Blob([content], { type });
}

/**
 * Read blob content as a string, using FileReader for jsdom compatibility.
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
export function readBlobText(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            if (typeof reader.result === "string") {
                resolve(reader.result);
            } else {
                reject(new Error("FileReader: expected string result"));
            }
        };
        reader.onerror = () =>
            reject(reader.error ?? new Error("FileReader error"));
        reader.readAsText(blob);
    });
}

/**
 * Push N consecutive 10-second fragments starting from startOffset.
 * @param {ReturnType<typeof makeAudioChunkCollector>} collector
 * @param {number} count
 * @param {number} [startOffset]
 * @param {string} [mimeType]
 */
export function pushFragments(
    collector,
    count,
    startOffset = 0,
    mimeType = "audio/webm"
) {
    for (let i = 0; i < count; i++) {
        const start = startOffset + i * FRAGMENT_MS;
        const end = start + FRAGMENT_MS;
        collector.push(
            makeBlob(`frag-${startOffset / FRAGMENT_MS + i}`, mimeType),
            start,
            end
        );
    }
}
