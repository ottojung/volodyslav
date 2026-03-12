/**
 * @module transcription_chunk_plan
 *
 * Pure chunk planning logic for audio transcription.
 * Determines whether an audio file should be split into chunks
 * and produces a deterministic plan for the split.
 *
 * No side effects – safe to test without mocks.
 */

/**
 * @typedef {object} ChunkSpec
 * @property {number} index - Zero-based chunk index.
 * @property {number} startMs - Start position in milliseconds.
 * @property {number} endMs - End position in milliseconds.
 * @property {number} overlapBeforeMs - How many ms of overlap exists at the start of this chunk with the previous chunk.
 */

/** Conservative safety margin below the 25 MB OpenAI upload limit. */
const MAX_SAFE_FILE_SIZE_BYTES = 20 * 1024 * 1024;

/** Target chunk duration (5 minutes). */
const TARGET_CHUNK_DURATION_MS = 5 * 60 * 1000;

/** Hard upper bound on a single chunk (6 minutes). */
const MAX_CHUNK_DURATION_MS = 6 * 60 * 1000;

/** Overlap between adjacent chunks. */
const OVERLAP_MS = 1000;

/**
 * Returns true when the file should be chunked before transcription.
 * @param {number} fileSizeBytes
 * @param {number} durationMs
 * @returns {boolean}
 */
function shouldChunk(fileSizeBytes, durationMs) {
    return fileSizeBytes > MAX_SAFE_FILE_SIZE_BYTES || durationMs > TARGET_CHUNK_DURATION_MS;
}

/**
 * Produces a deterministic list of chunk specifications for the given file.
 *
 * If no chunking is needed the list contains a single spec covering the whole file.
 * Otherwise it contains overlapping chunks of at most MAX_CHUNK_DURATION_MS each.
 *
 * Returned specs are sorted by index ascending.
 *
 * @param {number} fileSizeBytes - File size in bytes.
 * @param {number} durationMs - Total audio duration in milliseconds.
 * @returns {ChunkSpec[]}
 */
function planChunks(fileSizeBytes, durationMs) {
    if (!shouldChunk(fileSizeBytes, durationMs)) {
        return [{ index: 0, startMs: 0, endMs: durationMs, overlapBeforeMs: 0 }];
    }

    /** @type {ChunkSpec[]} */
    const chunks = [];
    let chunkStart = 0;
    let index = 0;

    while (chunkStart < durationMs) {
        const chunkEnd = Math.min(chunkStart + MAX_CHUNK_DURATION_MS, durationMs);
        const overlapBefore = index === 0 ? 0 : OVERLAP_MS;
        chunks.push({
            index,
            startMs: chunkStart,
            endMs: chunkEnd,
            overlapBeforeMs: overlapBefore,
        });
        // Next chunk starts at target boundary (before overlap is re-added at extraction time)
        chunkStart = chunkEnd;
        index++;
    }

    // Add leading overlap to every chunk after the first so adjacent chunks share audio
    for (let i = 1; i < chunks.length; i++) {
        const chunk = chunks[i];
        const prevChunk = chunks[i - 1];
        if (!chunk || !prevChunk) {
            continue;
        }
        chunks[i] = {
            index: chunk.index,
            startMs: Math.max(0, prevChunk.endMs - OVERLAP_MS),
            endMs: chunk.endMs,
            overlapBeforeMs: chunk.overlapBeforeMs,
        };
    }

    return chunks;
}

/**
 * Builds a continuity prompt from the tail of the already-stitched transcript.
 * The prompt is the last N characters of the transcript, trimmed to a word boundary.
 *
 * @param {string} transcript - The current accumulated transcript.
 * @param {number} [maxChars=224] - Maximum number of characters to include.
 * @returns {string} - A short tail of the transcript for use as a prompt.
 */
function buildContinuityPrompt(transcript, maxChars = 224) {
    const trimmed = transcript.trimEnd();
    if (trimmed.length <= maxChars) {
        return trimmed;
    }
    // Take the last maxChars characters and trim back to the nearest word boundary
    const candidate = trimmed.slice(trimmed.length - maxChars);
    const firstSpaceIdx = candidate.indexOf(" ");
    if (firstSpaceIdx === -1) {
        return candidate;
    }
    return candidate.slice(firstSpaceIdx + 1);
}

module.exports = {
    planChunks,
    shouldChunk,
    buildContinuityPrompt,
    MAX_SAFE_FILE_SIZE_BYTES,
    TARGET_CHUNK_DURATION_MS,
    MAX_CHUNK_DURATION_MS,
    OVERLAP_MS,
};
